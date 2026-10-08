#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync, execSync } from 'child_process';

const DEFAULT_MODEL = 'gemini-3.8-flash-medium';
const ENTITY_DIR = 'collections';
const TAG = '[COLLECTION]';
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
    const m = line.match(/^\s*DB_DATABASE\s*=(.*)$/);
    if (m) return m[1].replace(/\s/g, '');
  }
  return '';
}

const AGY_CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USER_NAME', 'DB_USER_PASSWORD']) delete env[key];
  return env;
})();

// Windows: agy 는 .cmd 래퍼로 설치되며 shell:false 로는 .cmd 를 실행할 수 없다 (ENOENT).
// 래퍼 안의 agy.exe 경로를 환경변수까지 풀어 절대 경로로 실행한다. 래퍼 형식은 설치 방식마다 다르다:
//   자체 설치 (WindowsApps\agy.cmd) : @"%LOCALAPPDATA%\agy\bin\agy.exe" %*
//   npm 전역 설치                    : "%dp0%\node_modules\...\agy.exe" %*
function resolveAgyBin(): string {
  const envPath = process.env.AGY_CLI_PATH?.trim();
  if (envPath) {
    try { execSync(`"${envPath}" --version`, { stdio: 'ignore' }); return envPath; } catch { /* fallback */ }
  }
  try {
    const shims = execSync('where agy.cmd', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\r?\n/);
    for (const shim of shims) {
      const shimDir = path.dirname(shim.trim());
      const m = fs.readFileSync(shim.trim(), 'utf-8').match(/"?([^"\r\n]*?agy\.exe)"?/i);
      if (!m) continue;
      const exePath = m[1]
        .replace(/^@/, '')
        .replace(/%~dp0|%dp0%/gi, `${shimDir}\\`)
        .replace(/%([^%]+)%/g, (whole: string, name: string) => process.env[name] ?? whole);
      const resolved = path.resolve(shimDir, exePath);
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
    if (result.error || result.status !== 0) {
      const reason = result.error ? ((result.error as NodeJS.ErrnoException).code ?? result.error.message) : `exit ${result.status}`;
      console.log(`  ⚠  agy models 조회 실패 (${reason}) — 기본 모델만 표시합니다.`);
      return [];
    }
    return (result.stdout ?? '').split('\n')
      .map(l => l.trim().split(/\s+/)[0])
      .filter(m => m.startsWith('gemini-'));
  } catch { return []; }
}

function buildBatchPrompt(dbName: string, batchSchema: string): string {
  return `아래는 MongoDB 데이터베이스 \`${dbName}\`의 컬렉션 정보 일부입니다:

\`\`\`
${batchSchema}
\`\`\`

위 컬렉션들에 대해 다음 JSON 만 반환하세요 (다른 텍스트 없이):
{
  "collections": {
    "<컬렉션명>": "<컬렉션명>.md 파일의 전체 markdown 내용",
    ...
  }
}

각 markdown 은 다음 형식:
# <컬렉션명>

> **database**: \`${dbName}\` | **건수**: N건

## 필드 목록

| 필드명 | 타입 | 설명 |
|--------|------|------|
| \`_id\` | ObjectId | 고유 식별자 |
| \`<필드명>\` | <타입> | 한글 설명 |

## 관련 컬렉션

- 관련 참조 관계 서술

index / mapping 등 다른 키는 넣지 마세요. collections 만.`;
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
  // 기본 모델을 항상 1번에 두어 Enter(default=1) 가 (default) 표시된 모델을 고르게 한다.
  models = [DEFAULT_MODEL, ...models.filter((m) => m !== DEFAULT_MODEL)];
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
  // generate-index.ts 도 같은 모델을 쓰도록 runTsx 가 상속하는 환경에도 설정한다.
  process.env.GEMINI_MODEL = model;
  console.log(`  선택된 모델: ${model}\n`);

  console.log('업데이트 범위를 선택하세요:');
  console.log('  1) 전체 업데이트 — 모든 컬렉션 재생성 + index.md/collection-mapping.md 갱신');
  console.log('  2) 부분 업데이트 — collections/ 폴더에 아직 .md 없는 컬렉션만');
  console.log('  3) 부분 업데이트 — 직접 지정한 컬렉션만');
  const modeChoice = (await ask('선택 [1-3, default=1]: ')).trim() || '1';

  let mode: 'full' | 'partial-missing' | 'partial-custom';
  let customNames = new Set<string>();
  switch (modeChoice) {
    case '1': mode = 'full'; break;
    case '2': mode = 'partial-missing'; break;
    case '3': {
      mode = 'partial-custom';
      const input = await ask('컬렉션명 입력 (공백 또는 쉼표 구분): ');
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
  console.log(`      컬렉션 ${blocks.length}개 추출 완료`);

  if (mode !== 'full') {
    blocks = blocks.filter((b) => mode === 'partial-missing'
      ? !fs.existsSync(path.join(ENTITY_DIR, `${nameOf(b)}.md`))
      : customNames.has(nameOf(b)));
    console.log(`      필터링 후 대상 ${blocks.length}개 (${mode})`);
    if (blocks.length === 0) { console.log('      대상 컬렉션이 없습니다. 종료.'); process.exit(0); }
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
    console.log(`  ── 배치 ${i + 1}/${batches.length} (${batch.length}개 컬렉션) ──`);
    const prompt = buildBatchPrompt(dbName, batch.map((b) => b.join('\n')).join('\n'));
    let output: string;
    try {
      output = runAgyBatch(agyBin, model, prompt);
    } catch (err) {
      console.log(`\n배치 ${i + 1} 오류: ${(err as Error).message}`);
      process.exit(1);
    }
    const parsed = extractJson(output) as Record<string, unknown> | null;
    const collections = parsed?.collections;
    if (!collections || typeof collections !== 'object') {
      console.log(`\n배치 ${i + 1} 오류: JSON 응답 파싱 실패\n${output.slice(0, 400)}`);
      process.exit(1);
    }
    for (const [name, content] of Object.entries(collections as Record<string, unknown>)) {
      if (typeof content !== 'string') continue;
      const safeName = name.replace(/[/\\]/g, '_');
      fs.writeFileSync(path.join(ENTITY_DIR, `${safeName}.md`), content, 'utf-8');
      done += 1;
      console.log(`      [${done}/${total}] ${name} 완료`);
    }
  }
  console.log('');

  if (mode !== 'full') {
    console.log(`  ✔ collections/ 부분 갱신 완료 (${done}개)`);
  } else {
    console.log('  ── 최종 단계: index.md · collection-mapping.md 생성 ──');
  }

  runTsx('scripts/generate-index.ts', false);

  if (mode === 'full') {
    console.log('');
    if (fs.existsSync('index.md')) console.log('  ✔ index.md 생성 완료');
    if (fs.existsSync('collection-mapping.md')) console.log('  ✔ collection-mapping.md 생성 완료');
    if (fs.existsSync(ENTITY_DIR)) console.log(`  ✔ collections/ 생성 완료 (${done}개)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
