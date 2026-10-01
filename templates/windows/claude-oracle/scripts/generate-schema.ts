#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn, spawnSync, execSync } from 'child_process';

const DB_DISPLAY_NAME = 'Oracle';
const DB_ENV_KEY = 'DB_SERVICE_NAME';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DOCS_URL = 'https://docs.anthropic.com/en/docs/about-claude/models';
const ENTITY_DIR = 'tables';
const MAPPING_FILE = 'table-mapping.md';
const TAG = '[TABLE]';
const BATCH_SIZE = 10;

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

const CLAUDE_CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['DB_HOST', 'DB_PORT', DB_ENV_KEY, 'DB_USER_NAME', 'DB_USER_PASSWORD']) delete env[key];
  return env;
})();

function resolveClaudeBin(): string {
  if (process.platform !== 'win32') return 'claude';
  try {
    const shims = execSync('where claude.cmd', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\r?\n/);
    for (const shim of shims) {
      const m = fs.readFileSync(shim.trim(), 'utf-8').match(/%~?dp0%?\\([^\s"]+claude\.exe)/i);
      if (!m) continue;
      const resolved = path.resolve(path.dirname(shim.trim()), m[1]);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch { /* fallback */ }
  return 'claude';
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

async function fetchModels(): Promise<string[]> {
  console.log('  (Anthropic docs 에서 모델 목록 조회 중...)');
  let models: string[] = [];
  try {
    const res = await fetch(DOCS_URL, { signal: AbortSignal.timeout(5000) });
    const html = await res.text();
    const current = html.split('Legacy models')[0];
    const found = new Set<string>();
    for (const m of current.matchAll(/(Haiku|Sonnet|Opus) (\d+\.\d+)/g)) {
      found.add(`claude-${m[1].toLowerCase()}-${m[2].replace('.', '-')}`);
    }
    models = [...found].sort().reverse();
  } catch { /* 조회 실패 → alias fallback */ }
  if (models.length === 0) models = ['haiku', 'sonnet', 'opus'];
  if (!models.includes(DEFAULT_MODEL)) models.unshift(DEFAULT_MODEL);
  return models;
}

function buildBatchPrompt(dbName: string, batchSchema: string): string {
  return `아래는 ${DB_DISPLAY_NAME} 데이터베이스 \`${dbName}\`의 테이블 정보 일부입니다:

\`\`\`
${batchSchema}
\`\`\`

위 테이블들 각각에 대해 \`${ENTITY_DIR}/<이름>.md\` 파일을 bash heredoc으로 현재 디렉토리에 작성하세요.
index.md 와 ${MAPPING_FILE} 는 생성하지 마세요 (이후 별도 단계에서 처리합니다).

## ${ENTITY_DIR}/<이름>.md 형식

\`\`\`
# <테이블명>

> **database**: \`${dbName}\` | **건수**: N건

## 컬럼 목록

| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| \`id\`  | int  | 고유 식별자 |
| \`<컬럼명>\` | <타입> | 한글 설명 |

## 관련 테이블

- 관련 참조 관계 서술
\`\`\`

## 작성 지침
- 각 컬럼의 한글 설명은 이름과 타입을 참고해 자연스럽게 작성하세요
- 반드시 mkdir -p ${ENTITY_DIR} 후 각 테이블마다 heredoc으로 파일 생성
`;
}

function buildFinalPrompt(dbName: string, fullSchema: string): string {
  return `아래는 ${DB_DISPLAY_NAME} 데이터베이스 \`${dbName}\`의 전체 테이블 정보입니다:

\`\`\`
${fullSchema}
\`\`\`

${ENTITY_DIR}/ 디렉토리에는 이미 각 테이블별 상세 .md 파일이 생성돼있습니다.
지금은 아래 2개 파일만 bash heredoc으로 현재 디렉토리에 작성하세요.

1. \`index.md\` — 전체 테이블 인덱스
2. \`${MAPPING_FILE}\` — 자연어 키워드 매핑

## index.md 형식
\`\`\`
# DB 테이블 인덱스
> **database**: \`${dbName}\` — N개 테이블 / M건
> 최종 업데이트: YYYY-MM-DD

## 테이블 목록

### 카테고리명
| 테이블명 | 한글 설명 |
|---------|---------|
| \`테이블명\` | 설명 (N건) |
\`\`\`

## ${MAPPING_FILE} 형식
\`\`\`
# 테이블 자연어 매핑 정의서

> **database**: \`${dbName}\`

## 카테고리명
| 테이블명 | 자연어 키워드 | 주요 컬럼 | 설명 |
|---------|-------------|---------|------|
| \`테이블명\` | 키워드1, 키워드2 | \`col1\`, \`col2\` | 설명 (N건) |
\`\`\`

## 작성 지침
- 테이블을 도메인별로 카테고리화하세요
- 한국어 키워드는 자연어 채팅 검색에 적합하게 작성하세요
- 건수 기준 내림차순으로 정렬하세요
`;
}

function runBatch(
  claudeBin: string, model: string, prompt: string, names: string[],
  progress: { done: number; total: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, ['-p', '--allowedTools', 'Bash', '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: CLAUDE_CHILD_ENV,
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.stdin.end(prompt);

    const seen = new Set<string>();
    const poll = () => {
      for (const name of names) {
        if (seen.has(name) || !fs.existsSync(path.join(ENTITY_DIR, `${name}.md`))) continue;
        seen.add(name);
        progress.done += 1;
        console.log(`      [${progress.done}/${progress.total}] ${name} 완료`);
      }
    };
    const timer = setInterval(poll, 300);

    child.on('error', (err) => { clearInterval(timer); reject(new Error(`${err.message}\n${log}`)); });
    child.on('close', (code) => {
      clearInterval(timer);
      poll();
      if (code === 0) resolve();
      else reject(new Error(log));
    });
  });
}

function runFinal(claudeBin: string, model: string, prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, ['-p', '--allowedTools', 'Bash', '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: CLAUDE_CHILD_ENV,
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.stdin.end(prompt);
    child.on('error', (err) => { reject(new Error(`${err.message}\n${log}`)); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(log));
    });
  });
}

async function main(): Promise<void> {
  const dbName = readDbName();
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string): Promise<string> => {
    process.stdout.write(question);
    const next = await lines.next();
    return next.done ? '' : next.value;
  };

  const models = await fetchModels();
  console.log('사용할 AI 모델을 선택하세요:');
  models.forEach((m, i) => console.log(`  ${i + 1}) ${m}${m === DEFAULT_MODEL ? ' (default)' : ''}`));
  const max = models.length + 1;
  console.log(`  ${max}) 직접 입력`);

  const modelChoice = (await ask(`선택 [1-${max}, default=1]: `)).trim() || '1';
  const modelIdx = Number(modelChoice);
  if (!/^\d+$/.test(modelChoice) || modelIdx < 1 || modelIdx > max) {
    console.log(`잘못된 선택: ${modelChoice}`);
    process.exit(1);
  }
  let model: string;
  if (modelIdx === max) {
    model = (await ask('모델명: ')).trim();
    if (!model) { console.log('모델명이 비어있습니다. 종료.'); process.exit(1); }
  } else {
    model = models[modelIdx - 1];
  }
  process.env.CLAUDE_MODEL = model;
  CLAUDE_CHILD_ENV.CLAUDE_MODEL = model;
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
    default:
      console.log(`잘못된 선택: ${modeChoice}`);
      process.exit(1);
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
  const claudeBin = resolveClaudeBin();
  const progress = { done: 0, total: blocks.length };
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`  ── 배치 ${i + 1}/${batches.length} (${batch.length}개 테이블) ──`);
    const prompt = buildBatchPrompt(dbName, batch.map((b) => b.join('\n')).join('\n'));
    try {
      await runBatch(claudeBin, model, prompt, batch.map(nameOf), progress);
    } catch (err) {
      console.log(`\n배치 ${i + 1} 오류:`);
      console.log((err as Error).message);
      process.exit(1);
    }
  }
  console.log('');

  if (mode !== 'full') {
    console.log(`  ✔ ${ENTITY_DIR}/ 부분 갱신 완료 (${progress.done}개)`);
    console.log('  ℹ  부분 업데이트 모드 — index.md · table-mapping.md 는 건드리지 않았습니다.');
    return;
  }

  console.log('  ── 최종 단계: index.md · table-mapping.md 생성 ──');
  fs.rmSync('index.md', { force: true });
  fs.rmSync(MAPPING_FILE, { force: true });
  try {
    await runFinal(claudeBin, model, buildFinalPrompt(dbName, fullSchema));
  } catch (err) {
    console.log('\n최종 단계 오류:');
    console.log((err as Error).message);
    process.exit(1);
  }

  console.log('');
  if (fs.existsSync('index.md')) console.log('  ✔ index.md 생성 완료');
  if (fs.existsSync(MAPPING_FILE)) console.log(`  ✔ ${MAPPING_FILE} 생성 완료`);
  if (fs.existsSync(ENTITY_DIR)) console.log(`  ✔ ${ENTITY_DIR}/ 생성 완료 (${progress.done}개)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
