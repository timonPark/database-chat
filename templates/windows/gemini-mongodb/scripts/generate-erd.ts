#!/usr/bin/env tsx
/**
 * MongoDB ERD 생성 — LLM 기반.
 *
 * `index.md` (컬렉션 인덱스) 와 `collection-mapping.md` (자연어 매핑, 주요 필드)
 * 두 파일을 agy (Gemini) CLI 에 넘겨 Mermaid ER 다이어그램을 생성한다.
 *
 * 이 접근의 이유:
 * - MongoDB 에는 FK 제약이 없어 관계는 도메인 지식으로 판단해야 한다.
 * - 정규식 기반 heuristic 은 (a) snake_case/camelCase, embedded array, soft join
 *   등 다양한 패턴을 커버하기 어렵고 (b) 관련 컬렉션 서술 프로즈에서
 *   false positive 를 대량 만든다 (예: 다른 도메인 이름이 언급되면 관계로 오인).
 * - LLM 은 문서를 읽고 도메인적 근접과 실제 참조를 구분할 수 있다.
 *
 * 결과는 프로젝트 루트의 `erd.mmd` 로 저장. 서버가 이 파일을 읽어 UI 에 전달.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { spawnSync, execSync } from 'child_process';

const INDEX_FILE: string = path.resolve('index.md');
const MAPPING_FILE: string = path.resolve('collection-mapping.md');
const COLLECTIONS_DIR: string = path.resolve('collections');
const OUTPUT_FILE: string = path.resolve('erd.mmd');
const MODEL: string = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash-medium';
const PRINT_TIMEOUT: string = process.env.GEMINI_PRINT_TIMEOUT?.trim() || '5m';
const ERD_BEGIN: string = '<<<ERD_MMD>>>';
const ERD_END: string = '<<<END_ERD_MMD>>>';

// dotenv 로 읽은 DB 자격증명이 agy 자식 프로세스로 상속되지 않게 제거한다.
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

// 응답에서 Mermaid 본문을 꺼낸다: 표시 사이 → ```mermaid 펜스 → erDiagram 으로 시작하는 줄 순서로 시도.
function extractErd(text: string): string | null {
  const start = text.indexOf(ERD_BEGIN);
  const stop = start === -1 ? -1 : text.indexOf(ERD_END, start + ERD_BEGIN.length);
  let body: string | null = start !== -1 && stop !== -1 ? text.slice(start + ERD_BEGIN.length, stop) : null;
  if (body === null) {
    const fence = text.match(/```mermaid\s*\n([\s\S]*?)\n```/i);
    body = fence ? fence[1] : null;
  }
  if (body === null) {
    const at = text.search(/^erDiagram\b/m);
    body = at === -1 ? null : text.slice(at);
  }
  if (body === null) return null;
  body = body.trim().replace(/^```(?:mermaid)?\s*\n/i, '').replace(/\n```\s*$/, '').trim();
  return body.startsWith('erDiagram') ? `${body}\n` : null;
}

if (!fs.existsSync(INDEX_FILE) || !fs.existsSync(MAPPING_FILE)) {
  console.error('index.md 또는 collection-mapping.md 가 없습니다.');
  console.error('먼저 npm run schema 를 실행하세요 (index.md · collection-mapping.md 자동 생성).');
  process.exit(1);
}
if (!fs.existsSync(COLLECTIONS_DIR)) {
  console.error(`collections/ 디렉토리가 없습니다: ${COLLECTIONS_DIR}`);
  process.exit(1);
}

const indexContent: string = fs.readFileSync(INDEX_FILE, 'utf-8');
const mappingContent: string = fs.readFileSync(MAPPING_FILE, 'utf-8');

// collections/*.md 원문을 모두 포함해 LLM 이 각 엔티티의 전체 필드 목록 + 실제
// 타입을 보고 ERD 를 그릴 수 있게 한다. mapping 의 "주요 필드" 만으로는 5~8개
// 밖에 안 노출돼 ERD 가 빈약해진다.
const collectionFiles: string[] = fs.readdirSync(COLLECTIONS_DIR)
  .filter((f: string) => f.endsWith('.md'))
  .sort();

let collectionsBlock: string = '';
for (const f of collectionFiles) {
  const name: string = f.replace(/\.md$/, '');
  const content: string = fs.readFileSync(path.join(COLLECTIONS_DIR, f), 'utf-8').trim();
  collectionsBlock += `\n### ${name}\n\`\`\`markdown\n${content}\n\`\`\`\n`;
}

const prompt: string = `아래는 MongoDB 데이터베이스의 컬렉션 인덱스, 자연어 매핑, 그리고 각 컬렉션의 상세 필드 문서입니다.
이 문서들을 근거로 Mermaid ER 다이어그램(erd.mmd 내용)을 만들어 출력하세요.

## index.md
\`\`\`markdown
${indexContent}
\`\`\`

## collection-mapping.md
\`\`\`markdown
${mappingContent}
\`\`\`

## collections/*.md — 각 컬렉션의 전체 필드 문서
${collectionsBlock}

## 파일 형식 (erd.mmd)

첫 줄은 \`erDiagram\`, 이후 각 엔티티 블록과 관계선.

### 엔티티 블록
\`\`\`
  <컬렉션명> {
    ObjectId _id PK
    <타입> <필드명>
    <타입> <필드명> FK
  }
\`\`\`

- \`_id\` (ObjectId) 는 항상 PK
- FK 는 실제 참조 관계가 있는 필드에만 표기 (관계 채택 기준 참조)
- **각 엔티티 블록에 collections/*.md 에 정의된 모든 필드를 포함**하세요
  (mapping 의 "주요 필드" 만으로 제한하지 말 것)
- 필드 타입은 collections/*.md 의 실제 타입을 그대로 사용
  (소문자 위주: \`string\`, \`number\`, \`array\`, \`object\`, \`date\`, \`boolean\`, \`ObjectId\`, \`decimal128\`, \`binary\` 등)
- 필드 이름의 공백은 언더스코어로 치환 (Mermaid 는 공백 있는 필드명을 허용하지 않음)
  예: \`start station id\` → \`start_station_id\`

### 관계선
\`\`\`
  <from> }o--|| <to> : "<라벨>"
\`\`\`
- 방향: 참조하는 쪽 → 참조받는 쪽 (예: \`comments }o--|| movies\`)
- 라벨: 참조 필드명 (예: \`"movie_id"\`)
- 양방향 중복 금지 (A→B 와 B→A 를 모두 그리지 말 것)

### 관계 채택 기준
실제 참조 근거가 문서에 명시된 경우만 그리세요:
1. **강한 FK**: 필드명이 다른 컬렉션의 도메인 이름 + \`Id/Obj/ObjectId/_id\` 패턴이고 대응 컬렉션이 존재
2. **문서 서술**: 컬렉션 문서의 \`## 관련 컬렉션\` 섹션에 명시된 참조 관계
3. **Embedded array 참조**: 배열 필드가 다른 컬렉션을 참조하는 것이 문서에 나타남 (예: \`accounts[]\` 배열이 \`analytics_accounts\` 참조)
4. **소프트 조인**: 양쪽 컬렉션에 동일한 매칭 키 필드가 있고 실제 조인이 가능한 경우 (예: \`comments.email\` ↔ \`users.email\`)

**도메인적 근접**(같은 카테고리이지만 조인 키 없음)은 절대 관계로 그리지 마세요.
확실하지 않으면 관계선을 생략하세요 — false positive 방지가 우선.

## 출력 형식

파일을 직접 만들지 말고, erd.mmd 전체 내용을 아래 표시 사이에 그대로 출력하세요.
표시 줄은 정확히 그대로 쓰고, 표시 바깥에는 아무것도 쓰지 마세요 (요약 · 설명 · 관계 목록 금지).

${ERD_BEGIN}
erDiagram
  ...
${ERD_END}
`;

console.error(`agy CLI 호출 (모델: ${MODEL})... 인덱스 ${(indexContent.length / 1024).toFixed(1)}KB + 매핑 ${(mappingContent.length / 1024).toFixed(1)}KB + 컬렉션 상세 ${(collectionsBlock.length / 1024).toFixed(1)}KB`);

// agy 는 프롬프트를 -p 인자로 받는다 (generate-schema.ts 와 동일한 호출 방식).
// 응답 텍스트를 이 프로세스가 파싱해 erd.mmd 로 저장한다 — 모델이 셸 · 경로로 파일을 쓰지 않으므로
// Windows 경로 · 인코딩 문제가 생기지 않는다.
const result = spawnSync(resolveAgyBin(), [
  '-p', prompt,
  '--dangerously-skip-permissions',
  '--output-format', 'text',
  '--model', MODEL,
  '--print-timeout', PRINT_TIMEOUT,
], {
  encoding: 'utf-8',
  env: AGY_CHILD_ENV,
  shell: false,
  maxBuffer: 256 * 1024 * 1024,
});

if (result.error) {
  const reason = (result.error as NodeJS.ErrnoException).code === 'ENOENT'
    ? 'agy CLI 를 찾을 수 없습니다 (install.bat 안내 참고)'
    : result.error.message;
  console.error(`agy CLI 실행 오류: ${reason}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`agy CLI 종료 코드 ${result.status}`);
  console.error((result.stderr ?? '').slice(-2000));
  process.exit(1);
}

const erd: string | null = extractErd((result.stdout ?? '').replace(/\r\n/g, '\n'));
if (!erd) {
  console.error('agy 응답에서 erDiagram 내용을 찾지 못했습니다. erd.mmd 는 변경하지 않았습니다.');
  console.error(`응답 앞부분: ${(result.stdout ?? '').slice(0, 400)}`);
  process.exit(1);
}
fs.writeFileSync(OUTPUT_FILE, erd, 'utf-8');

const saved: string = fs.readFileSync(OUTPUT_FILE, 'utf-8').trim();
const firstLine: string = saved.split('\n')[0].trim();
if (firstLine !== 'erDiagram') {
  console.error(`경고: erd.mmd 첫 줄이 'erDiagram' 이 아닙니다: '${firstLine}'`);
  console.error('렌더링 시 파스 에러 가능. 응답 확인 필요.');
}

const stats = fs.statSync(OUTPUT_FILE);
console.error(`erd.mmd 저장 완료 (${(stats.size / 1024).toFixed(1)}KB)`);
