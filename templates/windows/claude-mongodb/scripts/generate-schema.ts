#!/usr/bin/env tsx
/**
 * 스키마 인덱스 생성 (npm run schema) — Windows 용.
 *
 * mac template 의 scripts/generate-schema.sh 와 동일한 흐름을 Node 로 옮긴 것.
 * Why: Windows 에서 `bash` 는 WSL 런처(System32\bash.exe)로 잡히기 쉽고,
 *      python3 도 대개 Microsoft Store stub 이라 .sh 를 그대로 실행할 수 없다.
 *
 * 1) AI 모델 선택 · 업데이트 범위 선택 (대화형)
 * 2) scripts/extract-schema.ts 로 DB 스키마 추출 (자격증명은 이 프로세스·LLM 에 노출되지 않음)
 * 3) 10개 배치로 나눠 Claude CLI 가 collections/<이름>.md 작성
 * 4) scripts/generate-index.ts 로 index.md · collection-mapping.md 생성
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn, spawnSync, execSync } from 'child_process';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DOCS_URL = 'https://docs.anthropic.com/en/docs/about-claude/models';
const ENTITY_DIR = 'collections';
const TAG = '[COLLECTION]';
const BATCH_SIZE = 10;

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.log(`⚠  Node.js 18+ 필요 (현재: ${process.version})`);
  process.exit(1);
}

// .env 에서 DB_DATABASE 만 읽는다. dotenv 로 전체를 로드하면 자격증명이
// Claude 자식 프로세스 env 로 상속되므로 사용하지 않는다.
function readDbName(): string {
  if (!fs.existsSync('.env')) return '';
  for (const line of fs.readFileSync('.env', 'utf-8').split(/\r?\n/)) {
    if (line.startsWith('#')) continue;
    const m = line.match(/^\s*DB_DATABASE\s*=(.*)$/);
    if (m) return m[1].replace(/\s/g, '');
  }
  return '';
}

// Claude 자식 프로세스에 상속시키지 않을 민감 키 (server.ts 와 동일)
const CLAUDE_CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USER_NAME', 'DB_USER_PASSWORD']) delete env[key];
  return env;
})();

// Windows: npm 전역 설치 CLI 는 .cmd shim 이라 shell 없이 spawn 할 수 없다.
// shim 이 가리키는 claude.exe 절대경로를 찾아 직접 실행 (없으면 'claude' — 네이티브 설치는 .exe 라 그대로 동작).
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

// `npx --no-install tsx <script>` 실행. Windows 의 npx 는 .cmd 라 shell 경유 (인자 없는 고정 문자열만 사용).
function runTsx(script: string, capture: boolean) {
  return spawnSync(`npx --no-install tsx ${script}`, {
    shell: true,
    encoding: 'utf-8',
    stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

// "[COLLECTION] name | ..." 블록 단위로 분할
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
    // "Legacy models" 이전 섹션만 사용 (해당 문자열이 없으면 전체 HTML)
    const current = html.split('Legacy models')[0];
    const found = new Set<string>();
    for (const m of current.matchAll(/(Haiku|Sonnet|Opus) (\d+\.\d+)/g)) {
      found.add(`claude-${m[1].toLowerCase()}-${m[2].replace('.', '-')}`);
    }
    models = [...found].sort().reverse();
  } catch { /* 조회 실패 → alias fallback */ }

  // 크롤 실패 시 alias 3개 (CLI 가 alias 를 latest 로 항상 resolve)
  if (models.length === 0) models = ['haiku', 'sonnet', 'opus'];
  // default 가 리스트에 없으면 맨 앞에 추가 (사용자가 default 를 놓치지 않도록)
  if (!models.includes(DEFAULT_MODEL)) models.unshift(DEFAULT_MODEL);
  return models;
}

function buildBatchPrompt(dbName: string, batchSchema: string): string {
  return `아래는 MongoDB 데이터베이스 \`${dbName}\`의 컬렉션 정보 일부입니다:

\`\`\`
${batchSchema}
\`\`\`

위 컬렉션들 각각에 대해 \`collections/<이름>.md\` 파일을 bash heredoc으로 현재 디렉토리에 작성하세요.
index.md 와 collection-mapping.md 는 생성하지 마세요 (이후 별도 단계에서 처리합니다).

## collections/<이름>.md 형식

\`\`\`
# <컬렉션명>

> **database**: \`${dbName}\` | **건수**: N건

## 필드 목록

| 필드명 | 타입 | 설명 |
|--------|------|------|
| \`_id\` | ObjectId | 고유 식별자 |
| \`<필드명>\` | <타입> | 한글 설명 |

## 관련 컬렉션

- 관련 참조 관계 서술
\`\`\`

## 작성 지침
- 각 필드의 한글 설명은 이름과 타입을 참고해 자연스럽게 작성하세요
- 반드시 mkdir -p collections 후 각 컬렉션마다 heredoc으로 파일 생성
`;
}

// 배치 하나를 Claude CLI 로 처리하면서 collections/*.md 생성 진행 상황을 출력
function runBatch(
  claudeBin: string, model: string, prompt: string, names: string[],
  progress: { done: number; total: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    // 프롬프트는 stdin 으로 전달 (Windows 커맨드라인 길이 제한 · 여러 줄 인자 문제 회피)
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

async function main(): Promise<void> {
  const dbName = readDbName();
  // 줄 단위 async iterator 로 읽는다 — 입력이 파이프로 미리 들어와도 줄이 버려지지 않음
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string): Promise<string> => {
    process.stdout.write(question);
    const next = await lines.next();
    return next.done ? '' : next.value;
  };

  // ── AI 모델 선택 (#87) ──────────────────────────────────────────────────────
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
  // generate-index.ts 가 같은 모델을 쓰도록 전달
  process.env.CLAUDE_MODEL = model;
  CLAUDE_CHILD_ENV.CLAUDE_MODEL = model;
  console.log(`  선택된 모델: ${model}\n`);

  // ── 업데이트 범위 선택 (#83) ────────────────────────────────────────────────
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
    default:
      console.log(`잘못된 선택: ${modeChoice}`);
      process.exit(1);
  }
  rl.close();
  console.log(`  선택된 모드: ${mode}\n`);

  // ── [1/3] 스키마 추출 ──────────────────────────────────────────────────────
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

  // ── 기존 .md 삭제 (재생성 대상만) ──────────────────────────────────────────
  fs.mkdirSync(ENTITY_DIR, { recursive: true });
  let regenCount = 0;
  for (const b of blocks) {
    const file = path.join(ENTITY_DIR, `${nameOf(b)}.md`);
    if (fs.existsSync(file)) { fs.rmSync(file); regenCount += 1; }
  }
  console.log(`      기존 .md 재생성 대상 ${regenCount}개 삭제`);

  // ── [2/3] 10개 배치로 분할 ─────────────────────────────────────────────────
  const batches: string[][][] = [];
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) batches.push(blocks.slice(i, i + BATCH_SIZE));
  console.log(`[2/3] 배치 분할: 전체 ${batches.length}개 (배치당 최대 ${BATCH_SIZE}개)\n`);

  // ── [3/3] 배치별 LLM 호출 ──────────────────────────────────────────────────
  console.log(`[3/3] LLM 호출 시작 (모델: ${model})`);
  const claudeBin = resolveClaudeBin();
  const progress = { done: 0, total: blocks.length };
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`  ── 배치 ${i + 1}/${batches.length} (${batch.length}개 컬렉션) ──`);
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
    console.log(`  ✔ collections/ 부분 갱신 완료 (${progress.done}개)`);
  } else {
    console.log('  ── 최종 단계: index.md · collection-mapping.md 생성 ──');
  }

  // MongoDB: index.md / collection-mapping.md 를 collections/*.md 스캔으로 항상 재생성
  runTsx('scripts/generate-index.ts', false);

  if (mode === 'full') {
    console.log('');
    if (fs.existsSync('index.md')) console.log('  ✔ index.md 생성 완료');
    if (fs.existsSync('collection-mapping.md')) console.log('  ✔ collection-mapping.md 생성 완료');
    if (fs.existsSync(ENTITY_DIR)) console.log(`  ✔ collections/ 생성 완료 (${progress.done}개)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
