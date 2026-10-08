#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn, spawnSync, execSync } from 'child_process';

const DB_DISPLAY_NAME = 'MySQL';
const DB_ENV_KEY = 'DB_DATABASE';
const DEFAULT_MODEL = 'gpt-5.6-luna';
const ENTITY_DIR = 'tables';
const INDEX_FILE = 'index.md';
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

const CODEX_CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['DB_HOST', 'DB_PORT', DB_ENV_KEY, 'DB_USER_NAME', 'DB_USER_PASSWORD']) delete env[key];
  return env;
})();

interface CodexCommand { cmd: string; prefixArgs: string[] }

// Windows: codex.cmd shim 은 `node <npm>\node_modules\@openai\codex\bin\codex.js` 를 실행하는 래퍼다.
// shell:true 로 .cmd 를 띄우면 공백 포함 경로(사용자명 · %TEMP%)가 깨지므로,
// shim 에서 codex.js 경로를 찾아 현재 node 로 직접 실행한다 (shell:false).
function resolveCodexCommand(): CodexCommand {
  const envPath = process.env.CODEX_CLI_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) {
    return /\.js$/i.test(envPath)
      ? { cmd: process.execPath, prefixArgs: [envPath] }
      : { cmd: envPath, prefixArgs: [] };
  }
  try {
    const shims = execSync('where codex.cmd', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\r?\n/);
    for (const shim of shims) {
      const m = fs.readFileSync(shim.trim(), 'utf-8').match(/%~?dp0%?\\([^\s"]+codex\.js)/i);
      if (!m) continue;
      const codexJs = path.resolve(path.dirname(shim.trim()), m[1]);
      if (fs.existsSync(codexJs)) return { cmd: process.execPath, prefixArgs: [codexJs] };
    }
  } catch { /* fallback */ }
  return { cmd: 'codex', prefixArgs: [] };
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

function fetchModelsFromCache(): string[] {
  try {
    const cachePath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codex', 'models_cache.json');
    if (!fs.existsSync(cachePath)) return [];
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return (data.models ?? []).map((m: { slug?: string }) => m.slug).filter(Boolean) as string[];
  } catch { return []; }
}

// Windows 의 Codex 는 기본 셸이 PowerShell 이라 bash heredoc · 절대 경로 지시는 경로가 깨진다.
// 셸을 지정하지 않고 작업 디렉토리 기준 상대 경로로만 저장하게 한다.
const SAVE_RULES = `- 반드시 현재 작업 디렉토리 기준 상대 경로로 저장하세요 (절대 경로 금지)
- 셸 종류(PowerShell/bash)에 맞는 방법 또는 파일 편집 도구로 UTF-8 로 저장하세요
- 파일 저장 외의 응답(설명, 요약)은 최소화하세요`;

function buildBatchPrompt(dbName: string, batchSchema: string, names: string[]): string {
  return `아래는 ${DB_DISPLAY_NAME} 데이터베이스 \`${dbName}\`의 테이블 정보 일부입니다:

\`\`\`
${batchSchema}
\`\`\`

위 테이블 각각에 대해 \`${ENTITY_DIR}/<테이블명>.md\` 파일을 작성하세요.

## 저장 규칙
- 작성할 파일 (총 ${names.length}개): ${names.map((n) => `\`${ENTITY_DIR}/${n}.md\``).join(', ')}
- 파일명은 위 목록 그대로 사용하세요 (\`${TAG}\` 줄의 테이블명 — 대소문자 · 점(.) 변경 금지)
- \`${ENTITY_DIR}\` 디렉토리가 없으면 먼저 만드세요
- ${INDEX_FILE} · ${MAPPING_FILE} 등 다른 파일은 만들거나 수정하지 마세요 (이후 단계에서 처리)
${SAVE_RULES}

## <테이블명>.md 형식
\`\`\`markdown
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
- 각 컬럼의 한글 설명은 이름과 타입을 참고해 자연스럽게 작성하세요`;
}

function buildFinalPrompt(dbName: string, fullSchema: string): string {
  return `아래는 ${DB_DISPLAY_NAME} 데이터베이스 \`${dbName}\`의 전체 테이블 정보입니다:

\`\`\`
${fullSchema}
\`\`\`

이 정보를 바탕으로 \`${INDEX_FILE}\` 와 \`${MAPPING_FILE}\` 두 파일을 작성하세요 (기존 파일은 덮어쓰기).

## 저장 규칙
- 작성할 파일: \`${INDEX_FILE}\`, \`${MAPPING_FILE}\` (두 파일만)
- \`${ENTITY_DIR}/\` 아래 파일은 수정하지 마세요
${SAVE_RULES}

## ${INDEX_FILE} 형식
\`\`\`markdown
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
\`\`\`markdown
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
- 건수 기준 내림차순으로 정렬하세요`;
}

// 프롬프트는 stdin 으로 전달 — 인자로 넘기면 Windows 커맨드라인 길이 제한에 걸리고
// Codex 가 프롬프트 첫 단어를 인자로 오인한다 ("unexpected argument").
function runCodex(model: string, prompt: string, onPoll?: () => void): Promise<void> {
  const codex = resolveCodexCommand();
  const args = [...codex.prefixArgs, 'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--model', model];
  return new Promise((resolve, reject) => {
    const child = spawn(codex.cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: CODEX_CHILD_ENV, shell: false });
    // Codex 는 프롬프트 에코 등 상세 로그를 많이 출력한다. 화면에는 내보내지 않고 실패 시에만 보여준다.
    let log = '';
    child.stdout.on('data', (d: Buffer) => { log += d; });
    child.stderr.on('data', (d: Buffer) => { log += d; });
    const timer = onPoll ? setInterval(onPoll, 300) : undefined;
    const finish = (err?: Error): void => {
      clearInterval(timer);
      onPoll?.();
      if (err) reject(err); else resolve();
    };
    child.on('error', (err: NodeJS.ErrnoException) => finish(new Error(err.code === 'ENOENT'
      ? 'codex CLI 를 찾을 수 없습니다. npm install -g @openai/codex 로 설치하세요.'
      : err.message)));
    child.on('close', (code: number | null) => finish(code === 0 ? undefined : new Error(`Codex CLI 종료 코드 ${code}\n${log.slice(-2000)}`)));
    child.stdin.end(prompt);
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

  let models = fetchModelsFromCache();
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
  CODEX_CHILD_ENV.CODEX_MODEL = model;
  console.log(`  선택된 모델: ${model}\n`);

  console.log('업데이트 범위를 선택하세요:');
  console.log(`  1) 전체 업데이트 — 모든 테이블 재생성 + ${INDEX_FILE}/${MAPPING_FILE} 갱신`);
  console.log(`  2) 부분 업데이트 — ${ENTITY_DIR}/ 폴더에 아직 .md 없는 테이블만`);
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
  const fullSchema = extract.stdout.replace(/\r\n/g, '\n');
  let blocks = splitBlocks(fullSchema);
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
  const missing: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const names = batch.map(nameOf);
    console.log(`  ── 배치 ${i + 1}/${batches.length} (${batch.length}개 테이블) ──`);

    // Codex 가 파일을 쓰는 즉시 진행률을 표시하기 위해 디스크를 폴링한다.
    const seen = new Set<string>();
    const poll = (): void => {
      for (const name of names) {
        if (seen.has(name) || !fs.existsSync(path.join(ENTITY_DIR, `${name}.md`))) continue;
        seen.add(name);
        done += 1;
        console.log(`      [${done}/${total}] ${name} 완료`);
      }
    };

    const prompt = buildBatchPrompt(dbName, batch.map((b) => b.join('\n')).join('\n'), names);
    try {
      await runCodex(model, prompt, poll);
    } catch (err) {
      console.log(`\n배치 ${i + 1} 오류: ${(err as Error).message}`);
      process.exit(1);
    }
    missing.push(...names.filter((n) => !seen.has(n)));
  }
  console.log('');

  if (missing.length > 0) {
    console.log(`  ⚠  파일이 생성되지 않은 테이블 ${missing.length}개: ${missing.join(', ')}`);
    console.log('     schema.bat 를 다시 실행해 "2) 부분 업데이트 — .md 없는 테이블만" 으로 재시도하세요.\n');
  }

  if (mode !== 'full') {
    console.log(`  ✔ ${ENTITY_DIR}/ 부분 갱신 완료 (${done}개)`);
    console.log(`  ℹ  부분 업데이트 모드 — ${INDEX_FILE} · ${MAPPING_FILE} 는 건드리지 않았습니다.`);
    return;
  }

  // 템플릿에 기본 index.md · table-mapping.md 가 포함돼 있으므로 존재 여부가 아닌 수정 시각으로 갱신을 확인한다.
  console.log(`  ── 최종 단계: ${INDEX_FILE} · ${MAPPING_FILE} 생성 ──`);
  const mtimeOf = (file: string): number => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0);
  const before = new Map([INDEX_FILE, MAPPING_FILE].map((f) => [f, mtimeOf(f)]));
  try {
    await runCodex(model, buildFinalPrompt(dbName, fullSchema));
  } catch (err) {
    console.log(`\n최종 단계 오류: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log('');
  for (const [file, prev] of before) {
    if (mtimeOf(file) > prev) console.log(`  ✔ ${file} 생성 완료`);
    else console.log(`  ⚠  ${file} 가 갱신되지 않았습니다. schema.bat 를 다시 실행하세요.`);
  }
  console.log(`  ✔ ${ENTITY_DIR}/ 생성 완료 (${done}개)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
