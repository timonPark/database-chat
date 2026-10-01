#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync, execSync } from 'child_process';

const DB_DISPLAY_NAME = 'MySQL';
const DB_ENV_KEY = 'DB_DATABASE';
const DEFAULT_MODEL = 'gemini-3.8-flash-medium';
const ENTITY_DIR = 'tables';
const MAPPING_FILE = 'table-mapping.md';
const TAG = '[TABLE]';
const BATCH_SIZE = 10;
const PRINT_TIMEOUT = process.env.GEMINI_PRINT_TIMEOUT?.trim() || '5m';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.log(`⚠  Node.js 18+ 필요 (현재: ${process.version})`);
  process.exit(1);
}

function readDbName(): string {
  if (!fs.existsSync('.env')) return '';
  for (const line of fs.readFileSync('.env', 'utf-8').split(/\r?\n/)) {
    if (line.startsWith('#')) continue;
    const m = line.match(new RegExp(`^\\s*${DB_ENV_KEY}\\s*=(.*)\$`));
    if (m) return m[1].replace(/\s/g, '');
  }
  return '';
}

const AGY_CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['DB_HOST', 'DB_PORT', DB_ENV_KEY, 'DB_USER_NAME', 'DB_USER_PASSWORD']) delete env[key];
  return env;
})();

// Windows: npm 전역 설치 agy 는 .cmd shim 이라 shell:false 로 직접 실행 불가 (ENOENT).
function resolveAgyBin(): string {
  const envPath = process.env.AGY_CLI_PATH?.trim();
  if (envPath) {
    try { execSync(`"${envPath}" --version`, { stdio: 'ignore' }); return envPath; } catch { /* fallback */ }
  }
  try {
    const shims = execSync('where agy.cmd', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\r?\n/);
    for (const shim of shims) {
      const m = fs.readFileSync(shim.trim(), 'utf-8').match(/%~?dp0%?\\([^\s"]+agy\.exe)/i);
      if (!m) continue;
      const resolved = path.resolve(path.dirname(shim.trim()), m[1]);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch { /* fallback */ }
  return 'agy';
}

function runTsx(script: string, capture: boolean) {
  return spawnSync(`npx --no-install tsx ${script}`, {
    shell: true,
    encoding: 'utf-8',
    stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function splitBlocks(schema: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of schema.split('\n')) {
    if (line.startsWith(TAG)) {
      if (current.length) blocks.push(current);
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function nameOf(block: string[]): string {
  return block[0].slice(TAG.length).split('|')[0].replace(/ /g, '');
}

function fetchAgyModels(agyBin: string): string[] {
  try {
    const result = spawnSync(agyBin, ['models'], { encoding: 'utf-8', shell: false });
    if (result.status !== 0) return [];
    return (result.stdout ?? '').split('\n')
      .map(l => l.trim().split(/\s+/)[0])
      .filter(m => m.startsWith('gemini-'));
  } catch { return []; }
}

function buildBatchPrompt(dbName: string, batchSchema: string): string {
  return `아래는 ${DB_DISPLAY_NAME} 데이터베이스 \`${dbName}\`의 테이블 정보 일부입니다:

\`\`\`
${batchSchema}
\`\`\`

위 테이블들에 대해 다음 JSON 만 반환하세요 (다른 텍스트 없이):
{
  "tables": {
    "<테이블명>": "<테이블명>.md 파일의 전체 markdown 내용",
    ...
  }
}

각 markdown 은 다음 형식:
# <테이블명>

> **database**: \`${dbName}\` | **건수**: N건

## 컬럼 목록

| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| \`id\`  | int  | 고유 식별자 |
| \`<컬럼명>\` | <타입> | 한글 설명 |

## 관련 테이블

- 관련 참조 관계 서술

index / mapping 등 다른 키는 넣지 마세요. tables 만.`;
}

function buildFinalPrompt(dbName: string, fullSchema: string): string {
  return `아래는 ${DB_DISPLAY_NAME} 데이터베이스 \`${dbName}\`의 전체 테이블 정보입니다:

\`\`\`
${fullSchema}
\`\`\`

아래 JSON 만 반환하세요 (다른 텍스트 없이):
{
  "index": "index.md 파일의 전체 markdown 내용",
  "mapping": "${MAPPING_FILE} 파일의 전체 markdown 내용"
}

## index.md 형식
# DB 테이블 인덱스
> **database**: \`${dbName}\` — N개 테이블 / M건
> 최종 업데이트: YYYY-MM-DD

## 테이블 목록
### 카테고리명
| 테이블명 | 한글 설명 |
|---------|---------|
| \`테이블명\` | 설명 (N건) |

## ${MAPPING_FILE} 형식
# 테이블 자연어 매핑 정의서

> **database**: \`${dbName}\`

## 카테고리명
| 테이블명 | 자연어 키워드 | 주요 컬럼 | 설명 |
|---------|-------------|---------|------|
| \`테이블명\` | 키워드1, 키워드2 | \`col1\`, \`col2\` | 설명 (N건) |

## 작성 지침
- 테이블을 도메인별로 카테고리화하세요
- 한국어 키워드는 자연어 채팅 검색에 적합하게 작성하세요
- 건수 기준 내림차순으로 정렬하세요`;
}

function extractJson(text: string): unknown | null {
  const stripped = text.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/im, '').trim();
  const start = stripped.indexOf('{');
  if (start === -1) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(stripped.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

function runAgyBatch(agyBin: string, model: string, prompt: string): string {
  const result = spawnSync(
    agyBin,
    ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text', '--model', model, '--print-timeout', PRINT_TIMEOUT],
    { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, env: AGY_CHILD_ENV, shell: false }
  );
  if (result.error) throw result.error;
  return (result.stdout ?? '') + (result.stderr ?? '');
}

async function main(): Promise<void> {
  const dbName = readDbName();
  const agyBin = resolveAgyBin();

  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string): Promise<string> => {
    process.stdout.write(question);
    const next = await lines.next();
    return next.done ? '' : next.value;
  };

  let models = fetchAgyModels(agyBin);
  if (models.length === 0) models = [DEFAULT_MODEL];
  else if (!models.includes(DEFAULT_MODEL)) models.unshift(DEFAULT_MODEL);
  console.log('사용할 AI 모델을 선택하세요:');
  models.forEach((m, i) => console.log(`  ${i + 1}) ${m}${m === DEFAULT_MODEL ? ' (default)' : ''}`));
  const max = models.length + 1;
  console.log(`  ${max}) 직접 입력`);

  const modelChoice = (await ask(`선택 [1-${max}, default=1]: `)).trim() || '1';
  const modelIdx = Number(modelChoice);
  if (!/^\d+$/.test(modelChoice) || modelIdx < 1 || modelIdx > max) {
    console.log(`잘못된 선택: ${modelChoice}`); process.exit(1);
  }
  let model: string;
  if (modelIdx === max) {
    model = (await ask('모델명: ')).trim();
    if (!model) { console.log('모델명이 비어있습니다. 종료.'); process.exit(1); }
  } else {
    model = models[modelIdx - 1];
  }
  AGY_CHILD_ENV.GEMINI_MODEL = model;
  console.log(`  선택된 모델: ${model}\n`);

  console.log('업데이트 범위를 선택하세요:');
  console.log('  1) 전체 업데이트 — 모든 테이블 재생성 + index.md/table-mapping.md 갱신');
  console.log('  2) 부분 업데이트 — tables/ 폴더에 아직 .md 없는 테이블만');
  console.log('  3) 부분 업데이트 — 직접 지정한 테이블만');
  const modeChoice = (await ask('선택 [1-3, default=1]: ')).trim() || '1';

  let mode: 'full' | 'partial-missing' | 'partial-custom';
  let customNames = new Set<string>();
  switch (modeChoice) {
    case '1': mode = 'full'; break;
    case '2': mode = 'partial-missing'; break;
    case '3': {
      mode = 'partial-custom';
      const input = await ask('테이블명 입력 (공백 또는 쉼표 구분): ');
      customNames = new Set(input.split(/[\s,]+/).filter(Boolean));
      if (customNames.size === 0) { console.log('입력이 비어있습니다. 종료.'); process.exit(1); }
      break;
    }
    default: console.log(`잘못된 선택: ${modeChoice}`); process.exit(1);
  }
  rl.close();
  console.log(`  선택된 모드: ${mode}\n`);

  console.log('[1/3] DB 스키마 추출 중...');
  const extract = runTsx('scripts/extract-schema.ts', true);
  if (extract.status !== 0) process.exit(extract.status ?? 1);
  let blocks = splitBlocks(extract.stdout.replace(/\r\n/g, '\n'));
  const fullSchema = extract.stdout.replace(/\r\n/g, '\n');
  console.log(`      테이블 ${blocks.length}개 추출 완료`);

  if (mode !== 'full') {
    blocks = blocks.filter((b) => mode === 'partial-missing'
      ? !fs.existsSync(path.join(ENTITY_DIR, `${nameOf(b)}.md`))
      : customNames.has(nameOf(b)));
    console.log(`      필터링 후 대상 ${blocks.length}개 (${mode})`);
    if (blocks.length === 0) { console.log('      대상 테이블이 없습니다. 종료.'); process.exit(0); }
  }
  console.log('');

  fs.mkdirSync(ENTITY_DIR, { recursive: true });
  let regenCount = 0;
  for (const b of blocks) {
    const file = path.join(ENTITY_DIR, `${nameOf(b)}.md`);
    if (fs.existsSync(file)) { fs.rmSync(file); regenCount += 1; }
  }
  console.log(`      기존 .md 재생성 대상 ${regenCount}개 삭제`);

  const batches: string[][][] = [];
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) batches.push(blocks.slice(i, i + BATCH_SIZE));
  console.log(`[2/3] 배치 분할: 전체 ${batches.length}개 (배치당 최대 ${BATCH_SIZE}개)\n`);

  console.log(`[3/3] LLM 호출 시작 (모델: ${model})`);
  let done = 0;
  const total = blocks.length;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`  ── 배치 ${i + 1}/${batches.length} (${batch.length}개 테이블) ──`);
    const prompt = buildBatchPrompt(dbName, batch.map((b) => b.join('\n')).join('\n'));
    let output: string;
    try {
      output = runAgyBatch(agyBin, model, prompt);
    } catch (err) {
      console.log(`\n배치 ${i + 1} 오류: ${(err as Error).message}`);
      process.exit(1);
    }
    const parsed = extractJson(output) as Record<string, unknown> | null;
    const tables = parsed?.tables;
    if (!tables || typeof tables !== 'object') {
      console.log(`\n배치 ${i + 1} 오류: JSON 응답 파싱 실패\n${output.slice(0, 400)}`);
      process.exit(1);
    }
    for (const [name, content] of Object.entries(tables as Record<string, unknown>)) {
      if (typeof content !== 'string') continue;
      const safeName = name.replace(/[/\\]/g, '_');
      fs.writeFileSync(path.join(ENTITY_DIR, `${safeName}.md`), content, 'utf-8');
      done += 1;
      console.log(`      [${done}/${total}] ${name} 완료`);
    }
  }
  console.log('');

  if (mode !== 'full') {
    console.log(`  ✔ ${ENTITY_DIR}/ 부분 갱신 완료 (${done}개)`);
    console.log('  ℹ  부분 업데이트 모드 — index.md · table-mapping.md 는 건드리지 않았습니다.');
    return;
  }

  console.log('  ── 최종 단계: index.md · table-mapping.md 생성 ──');
  let finalOutput: string;
  try {
    finalOutput = runAgyBatch(agyBin, model, buildFinalPrompt(dbName, fullSchema));
  } catch (err) {
    console.log(`\n최종 단계 오류: ${(err as Error).message}`);
    process.exit(1);
  }
  const finalParsed = extractJson(finalOutput) as Record<string, unknown> | null;
  if (!finalParsed) {
    console.log(`\n최종 단계 오류: JSON 응답 파싱 실패\n${finalOutput.slice(0, 400)}`);
    process.exit(1);
  }
  if (finalParsed.index) fs.writeFileSync('index.md', String(finalParsed.index), 'utf-8');
  if (finalParsed.mapping) fs.writeFileSync(MAPPING_FILE, String(finalParsed.mapping), 'utf-8');

  console.log('');
  if (fs.existsSync('index.md')) console.log('  ✔ index.md 생성 완료');
  if (fs.existsSync(MAPPING_FILE)) console.log(`  ✔ ${MAPPING_FILE} 생성 완료`);
  if (fs.existsSync(ENTITY_DIR)) console.log(`  ✔ ${ENTITY_DIR}/ 생성 완료 (${done}개)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
