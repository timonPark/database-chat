#!/usr/bin/env tsx
/**
 * MongoDB ERD 생성 — LLM 기반.
 *
 * `index.md` (컬렉션 인덱스) 와 `collection-mapping.md` (자연어 매핑, 주요 필드)
 * 두 파일을 Claude CLI 에 넘겨 Mermaid ER 다이어그램을 생성한다.
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
import { spawnSync } from 'child_process';

const INDEX_FILE: string = path.resolve('index.md');
const MAPPING_FILE: string = path.resolve('collection-mapping.md');
const COLLECTIONS_DIR: string = path.resolve('collections');
const OUTPUT_FILE: string = path.resolve('erd.mmd');
const MODEL: string = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';

if (!fs.existsSync(INDEX_FILE) || !fs.existsSync(MAPPING_FILE)) {
  console.error('index.md 또는 collection-mapping.md 가 없습니다.');
  console.error('먼저 pnpm run schema 를 실행하세요 (index.md · collection-mapping.md 자동 생성).');
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
이 문서들을 근거로 Mermaid ER 다이어그램을 만들어 현재 디렉토리의 \`erd.mmd\` 파일로 저장하세요.
저장은 반드시 bash heredoc 을 사용하세요 (설명이나 다른 도구 사용 금지).

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

## 작성 방식

bash heredoc 으로 아래 **절대 경로** 에 저장하세요. 상대 경로나 다른 경로 금지.

\`\`\`bash
cat > '${OUTPUT_FILE}' <<'ERD_EOF'
erDiagram
  ...
ERD_EOF
\`\`\`

파일 저장 외의 응답(요약, 설명, 관계 목록 등)은 최소화하세요.
`;

console.error(`Claude CLI 호출 (모델: ${MODEL})... 인덱스 ${(indexContent.length / 1024).toFixed(1)}KB + 매핑 ${(mappingContent.length / 1024).toFixed(1)}KB + 컬렉션 상세 ${(collectionsBlock.length / 1024).toFixed(1)}KB`);

// generate-schema.sh 와 동일한 패턴: Bash 툴만 허용해 Claude 가 heredoc 으로
// 직접 파일을 쓴다. stdout 은 요약 텍스트가 나오지만 무시한다 — 우리는
// 파일 존재 여부와 첫 줄이 erDiagram 인지만 확인한다.
const result = spawnSync('claude', [
  '-p', prompt,
  '--model', MODEL,
  '--allowedTools', 'Bash',
], {
  encoding: 'utf-8',
  stdio: ['ignore', 'inherit', 'inherit'],
});

if (result.error) {
  console.error(`Claude CLI 실행 오류: ${result.error.message}`);
  console.error('claude CLI 가 PATH 에 있는지 확인하세요.');
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`Claude CLI 종료 코드 ${result.status}`);
  process.exit(1);
}

if (!fs.existsSync(OUTPUT_FILE)) {
  console.error(`erd.mmd 파일이 생성되지 않았습니다. Claude 응답을 확인하세요.`);
  process.exit(1);
}

const saved: string = fs.readFileSync(OUTPUT_FILE, 'utf-8').trim();
const firstLine: string = saved.split('\n')[0].trim();
if (firstLine !== 'erDiagram') {
  console.error(`경고: erd.mmd 첫 줄이 'erDiagram' 이 아닙니다: '${firstLine}'`);
  console.error('렌더링 시 파스 에러 가능. 응답 확인 필요.');
}

const stats = fs.statSync(OUTPUT_FILE);
console.error(`erd.mmd 저장 완료 (${(stats.size / 1024).toFixed(1)}KB)`);
