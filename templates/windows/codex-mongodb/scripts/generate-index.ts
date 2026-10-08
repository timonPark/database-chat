#!/usr/bin/env tsx
/**
 * `index.md` + `collection-mapping.md` 생성.
 *
 * 두 단계로 동작한다:
 * 1) Deterministic skeleton — collections/*.md 스캔해 정확한 컬렉션 목록/건수/주요
 *    필드를 뽑아 두 파일을 임시로 저장. LLM 호출이 실패해도 최소한 이 골격은
 *    남는다 (실제 DB 상태와 100% 일치).
 * 2) LLM enrichment — Codex CLI 에 skeleton + collections/*.md 를 넘겨 도메인
 *    카테고리(이모지 + 한글), 컬렉션별 한국어 설명, 자연어 키워드를 채운 최종
 *    버전으로 덮어쓴다. 실패 시 skeleton 유지.
 *
 * enrichment 가 중요한 이유:
 * - server.ts 의 `buildCollectionGuide()` 가 collection-mapping.md 의 자연어
 *   키워드를 LLM 시스템 프롬프트에 주입한다. 키워드가 비어있으면 채팅에서
 *   사용자의 자연어 표현("약물 요약", "혈압" 등) 이 어떤 컬렉션인지 LLM 이
 *   판단하기 어렵다.
 * - `/meta/table-info` UI 는 index.md 를 그대로 보여준다. 카테고리 없이
 *   prefix 만 있는 skeleton 은 사용자가 컬렉션을 도메인적으로 이해하기 어렵다.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';

const COLLECTIONS_DIR: string = path.resolve('collections');
const INDEX_FILE: string = path.resolve('index.md');
const MAPPING_FILE: string = path.resolve('collection-mapping.md');
const DB_NAME: string = process.env.DB_DATABASE ?? '(DB_DATABASE 미지정)';
const MODEL: string = process.env.CODEX_MODEL ?? 'gpt-5.6-luna';
const SKELETON_MARKER: string = 'skeleton — LLM enrichment 대기 중';

// dotenv 로 읽은 DB 자격증명이 Codex 자식 프로세스로 상속되지 않게 제거한다.
const CODEX_CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USER_NAME', 'DB_USER_PASSWORD']) delete env[key];
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

if (!fs.existsSync(COLLECTIONS_DIR)) {
  console.error(`collections/ 디렉토리가 없습니다: ${COLLECTIONS_DIR}`);
  console.error('먼저 npm run schema 를 실행하세요.');
  process.exit(1);
}

const files: string[] = fs.readdirSync(COLLECTIONS_DIR)
  .filter((f: string) => f.endsWith('.md'))
  .sort();

if (files.length === 0) {
  console.error('collections/*.md 파일이 없습니다.');
  process.exit(1);
}

interface CollectionInfo {
  name: string;
  countRaw: string;
  count: number | null;
  mainFields: string[];
  content: string;
}

function parseCollection(filepath: string): CollectionInfo {
  const name: string = path.basename(filepath, '.md');
  const content: string = fs.readFileSync(filepath, 'utf-8');
  const countMatch: RegExpMatchArray | null = content.match(/\*\*건수\*\*[:：]\s*([\d,]+)\s*건/);
  const countRaw: string = countMatch ? countMatch[1] : '';
  const count: number | null = countRaw ? parseInt(countRaw.replace(/,/g, ''), 10) : null;

  const mainFields: string[] = [];
  const fieldSection: RegExpMatchArray | null = content.match(/##\s*필드\s*목록[\s\S]*?(?=##|$)/);
  if (fieldSection) {
    const rowRe: RegExp = /^\|\s*`([^`]+)`\s*\|/gm;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(fieldSection[0])) !== null) {
      const fname: string = m[1].trim();
      if (fname === '_id') continue;
      if (mainFields.length < 6) mainFields.push(fname);
    }
  }
  return { name, countRaw, count, mainFields, content };
}

const collections: CollectionInfo[] = files.map((f: string) => parseCollection(path.join(COLLECTIONS_DIR, f)));
const today: string = new Date().toISOString().slice(0, 10);

// ── 1단계: Deterministic skeleton 저장 ────────────────────────────────────────
// LLM enrichment 실패 시에도 최소한의 정확한 파일이 남도록 먼저 저장한다.

function writeSkeleton(): void {
  // 첫 언더스코어 앞부분을 도메인 prefix 로 사용 (LLM 이 재분류할 예정이지만
  // enrichment 실패 시 fallback 으로 이 그룹핑이 남는다)
  const groups: Map<string, CollectionInfo[]> = new Map();
  for (const c of collections) {
    const prefix: string = c.name.includes('_') ? c.name.split('_')[0] : c.name;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(c);
  }
  const sortedPrefixes: string[] = [...groups.keys()].sort();

  {
    const lines: string[] = [];
    lines.push('# 컬렉션 인덱스');
    lines.push('');
    lines.push(`> **database**: \`${DB_NAME}\` — ${collections.length}개 컬렉션`);
    lines.push(`> 최종 업데이트: ${today}`);
    lines.push(`> 자동 생성 (${SKELETON_MARKER})`);
    lines.push('');
    for (const prefix of sortedPrefixes) {
      const items: CollectionInfo[] = groups.get(prefix)!;
      lines.push(`## ${prefix} (${items.length}개)`);
      lines.push('');
      lines.push('| 컬렉션명 | 설명 |');
      lines.push('|---------|------|');
      for (const c of items) {
        const countStr: string = c.countRaw ? `(${c.countRaw}건)` : '';
        lines.push(`| \`${c.name}\` | ${countStr} |`);
      }
      lines.push('');
    }
    fs.writeFileSync(INDEX_FILE, lines.join('\n'));
  }
  {
    const lines: string[] = [];
    lines.push('# 컬렉션 자연어 매핑 정의서');
    lines.push('');
    lines.push(`> **database**: \`${DB_NAME}\``);
    lines.push(`> 최종 업데이트: ${today}`);
    lines.push(`> 자동 생성 (${SKELETON_MARKER})`);
    lines.push('');
    for (const prefix of sortedPrefixes) {
      const items: CollectionInfo[] = groups.get(prefix)!;
      lines.push(`## ${prefix}`);
      lines.push('');
      lines.push('| 컬렉션명 | 자연어 키워드 | 주요 필드 | 설명 |');
      lines.push('|---------|-------------|---------|------|');
      for (const c of items) {
        const fieldsStr: string = c.mainFields.map((f) => `\`${f}\``).join(', ');
        const desc: string = c.countRaw ? `(${c.countRaw}건)` : '';
        lines.push(`| \`${c.name}\` |  | ${fieldsStr} | ${desc} |`);
      }
      lines.push('');
    }
    fs.writeFileSync(MAPPING_FILE, lines.join('\n'));
  }
}

writeSkeleton();
console.error(`skeleton 저장 완료 (${collections.length}개 컬렉션)`);

// ── 2단계: LLM enrichment ────────────────────────────────────────────────────
// collections/*.md 원문을 프롬프트에 포함해 Codex 가 도메인 카테고리와 자연어
// 키워드, 한국어 설명을 채워 두 파일을 덮어쓴다.

let collectionsBlock: string = '';
for (const c of collections) {
  collectionsBlock += `\n### ${c.name}\n\`\`\`markdown\n${c.content.trim()}\n\`\`\`\n`;
}

const skeletonList: string = collections.map(
  (c) => `- \`${c.name}\`${c.countRaw ? ` (${c.countRaw}건)` : ''}`
).join('\n');

const prompt: string = `아래는 MongoDB 데이터베이스 \`${DB_NAME}\` 의 컬렉션 상세 문서들입니다.
이 정보를 바탕으로 두 파일을 생성하세요:

1. \`index.md\` — 도메인별 카테고리로 그룹핑된 컬렉션 인덱스
2. \`collection-mapping.md\` — 자연어 매핑 (도메인 카테고리 + 자연어 키워드 + 주요 필드 + 설명)

## 컬렉션 전체 목록 (총 ${collections.length}개, 반드시 모두 포함)
${skeletonList}

## 각 컬렉션 상세 문서
${collectionsBlock}

## 요구사항

### 도메인 카테고리
- prefix 로만 그룹핑하지 말고 각 컬렉션의 실제 도메인(용도) 을 파악해 카테고리로 묶으세요
- 각 카테고리에 이모지 + 한국어 이름 + (English) 부여 (예: \`📋 의약품 관리 (Medication)\`, \`🎬 영화 (Movies)\`, \`👤 사용자 (Users)\` 등)
- 카테고리 이름은 도메인 정합성을 우선. 같은 prefix 라도 다른 도메인이면 분리 가능

### 컬렉션 설명 (한국어)
- 각 컬렉션이 어떤 데이터를 저장하는지 한 문장으로 서술
- 건수는 반드시 표기 (형식: 큰 숫자는 K/M 축약 가능. 예: \`(1.2M건)\`, \`(41K건)\`, \`(1,564건)\`)

### 자연어 키워드 (mapping 만 해당)
- 사용자가 채팅에서 이 컬렉션을 찾을 때 쓸만한 자연어 표현 3~5개
- 예시: \`영화 정보\` 컬렉션 → \`영화, 무비, 작품, 감독, 장르\`
- 컬렉션명이 아닌 사용자 관점의 표현

### 주요 필드 (mapping 만 해당)
- 각 컬렉션 문서의 상위 3~5개 필드명 (백틱으로 감싸기)

## 파일 형식

### index.md
\`\`\`markdown
# 컬렉션 인덱스

> **database**: \`${DB_NAME}\` — ${collections.length}개 컬렉션
> 최종 업데이트: ${today}

---

## 컬렉션 목록

### 이모지 도메인이름 (English)
| 컬렉션명 | 설명 |
|---------|------|
| \`컬렉션명\` | 한국어 설명 (건수) |
\`\`\`

### collection-mapping.md
\`\`\`markdown
# 컬렉션 자연어 매핑 정의서

> **database**: \`${DB_NAME}\`
> **목적**: 자연어 검색 쿼리를 적절한 컬렉션으로 매핑하기 위한 키워드 사전

---

## 이모지 도메인이름
| 컬렉션명 | 자연어 키워드 | 주요 필드 | 설명 |
|---------|-------------|---------|------|
| \`컬렉션명\` | 키워드1, 키워드2, 키워드3 | \`field1\`, \`field2\` | 한국어 설명 (건수) |
\`\`\`

## 작성 지침

- **모든 ${collections.length}개 컬렉션이 두 파일에 빠짐없이 포함되어야 함**
- 두 파일의 카테고리 그룹핑은 동일하게 유지
- 카테고리 순서는 중요도/사용 빈도 순 권장

## 저장

현재 작업 디렉토리에 \`index.md\`, \`collection-mapping.md\` 두 파일을 덮어써서 저장하세요.
- 반드시 상대 경로 \`index.md\`, \`collection-mapping.md\` 로 저장 (절대 경로 · 다른 위치 금지 — 서버가 못 읽음)
- 셸 종류(PowerShell/bash)에 맞는 방법 또는 파일 편집 도구로 UTF-8 로 저장
- \`collections/\` 아래 파일은 수정하지 마세요

파일 저장 외의 응답(설명, 요약)은 최소화하세요.
`;

const promptSize: number = prompt.length;
console.error(`LLM enrichment 호출 (모델: ${MODEL}, 프롬프트 ${(promptSize / 1024).toFixed(1)}KB)...`);

// 프롬프트는 stdin 으로 전달 — 수십 KB 프롬프트를 인자로 넘기면 Windows 커맨드라인
// 길이 제한(ENAMETOOLONG)에 걸린다. Codex 의 상세 로그는 실패 시에만 보여준다.
const codex: CodexCommand = resolveCodexCommand();
const exitCode: number | null = await new Promise<number | null>((resolve) => {
  const child = spawn(codex.cmd, [
    ...codex.prefixArgs,
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    '--model', MODEL,
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: CODEX_CHILD_ENV, shell: false });
  let log: string = '';
  child.stdout.on('data', (d: Buffer) => { log += d; });
  child.stderr.on('data', (d: Buffer) => { log += d; });
  child.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`Codex CLI 실행 오류: ${err.code === 'ENOENT' ? 'codex CLI 를 찾을 수 없습니다 (npm install -g @openai/codex)' : err.message}`);
    resolve(null);
  });
  child.on('close', (code: number | null) => {
    if (code !== 0 && code !== null) console.error(log.slice(-2000));
    resolve(code);
  });
  child.stdin.end(prompt);
});

if (exitCode !== 0) {
  console.error(`Codex CLI 종료 코드 ${exitCode}. Skeleton 유지 — 나중에 다시 실행하면 enrichment 재시도.`);
  process.exit(0);
}

// 검증: enrichment 후 파일이 여전히 존재하고 skeleton 마커가 사라졌는지 확인
if (!fs.existsSync(INDEX_FILE) || !fs.existsSync(MAPPING_FILE)) {
  console.error('경고: enrichment 후 파일이 사라졌습니다. Skeleton 재생성.');
  writeSkeleton();
  process.exit(1);
}
const stillSkeleton: string[] = [INDEX_FILE, MAPPING_FILE]
  .filter((f) => fs.readFileSync(f, 'utf-8').includes(SKELETON_MARKER))
  .map((f) => path.basename(f));
if (stillSkeleton.length > 0) {
  console.error(`경고: ${stillSkeleton.join(', ')} 가 갱신되지 않아 skeleton 상태입니다. schema.bat 를 다시 실행하세요.`);
}

const indexSize: number = fs.statSync(INDEX_FILE).size;
const mappingSize: number = fs.statSync(MAPPING_FILE).size;
console.error(`enrichment 완료: index.md ${(indexSize / 1024).toFixed(1)}KB + collection-mapping.md ${(mappingSize / 1024).toFixed(1)}KB`);
