# Oracle schema index generation for Codex

You are generating user-facing Korean markdown files for a natural-language Oracle Database chat app.

Analyze the schema below and return exactly one valid JSON object. Do not wrap it in markdown fences. Do not add commentary before or after the JSON.

Schema source:

```text
{{SCHEMA}}
```

Database/service name: `{{DB_DATABASE}}`
Last updated: `{{TODAY}}`

## Required JSON shape

```json
{
  "index": "complete markdown content for index.md",
  "mapping": "complete markdown content for table-mapping.md"
}
```

Both values must be strings. Escape newlines as `\n` and double quotes as needed so the entire response is parseable JSON.

## Input format

The schema is emitted as repeated blocks:

```text
[TABLE] TABLE_NAME | 123건
  COLUMN_NAME: VARCHAR2 NOT NULL PK
  AMOUNT: NUMBER NULL
```

## index.md requirements

Create Korean markdown with this structure:

```markdown
# DB 테이블 인덱스
> **database**: `{{DB_DATABASE}}` — N개 테이블 / M건
> 최종 업데이트: {{TODAY}}

## 테이블 목록

### 카테고리명
| 테이블명 | 한글 설명 |
|---------|---------|
| `TABLE_NAME` | 설명 (123건) |

---

## 파일 구조

```text
tables/
├── TABLE_NAME.md    # 설명 (123건)
```

---

## 컬럼 타입 규칙

- 날짜 컬럼 → DATE / TIMESTAMP
- 금액 컬럼 → NUMBER
- 문자열 컬럼 → VARCHAR2 / CHAR / CLOB
```

## table-mapping.md requirements

Create Korean markdown with this structure:

```markdown
# 테이블 자연어 매핑 정의서

> **database**: `{{DB_DATABASE}}`

---

## 카테고리명

| 테이블명 | 자연어 키워드 | 주요 컬럼 | 설명 |
|---------|-------------|---------|------|
| `TABLE_NAME` | 키워드1, 키워드2, 키워드3 | `COL1`, `COL2` | 설명 (123건) |
```

## Writing rules

- Group tables into practical domain categories inferred from names, columns, and key columns.
- Sort tables by row count descending within each category.
- Use natural Korean descriptions suitable for business users.
- Include Korean search keywords that a user might type in a chat UI.
- Prefer business-relevant columns and primary key columns as `주요 컬럼`.
- Omit sensitive columns such as `PASSWORD`, `PASS_HASH`, `PASSWD`, `PWD`, and `SECRET`.
- Keep Oracle table and column names exactly as provided, including uppercase names.
