# Oracle schema index generation for Gemini (agy)

You are a JSON generator. You are NOT an interactive agent. You must NOT think out loud, plan, describe your steps, or write any prose.

Your entire response must be a single raw JSON object that satisfies `JSON.parse`.

Absolute output rules (violating any of these is a task failure):

- Return **only** raw JSON. No preface. No epilogue. No commentary.
- Do **not** wrap the JSON in markdown fences (no ```json, no ```).
- Do **not** describe what you are about to do or what you just did.
- Do **not** ask questions. Do **not** ask for confirmation.
- Do **not** emit XML/HTML tags.
- The first character of your response must be `{`. The last character must be `}`.
- Escape newlines inside string values as `\n`. Escape internal double quotes as `\"`. The whole response must be parseable by `JSON.parse`.

You are generating user-facing Korean markdown files for a natural-language Oracle Database chat app.

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
  "mapping": "complete markdown content for table-mapping.md",
  "tables": {
    "TABLE_NAME": "complete markdown content for tables/TABLE_NAME.md"
  }
}
```

The `index` and `mapping` values must be strings. Escape newlines as `\n` and double quotes as needed so the entire response is parseable JSON.
The `tables` value must contain one key for every table. Each key must be the exact Oracle table name (preserve uppercase, e.g. `EMPLOYEES`) and each value must be the complete Markdown content for that table's detail file.

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
| `TABLE_NAME` | 설명 (N건) |

---

## 파일 구조

```text
tables/
├── TABLE_NAME.md    # 설명 (N건)
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
| `TABLE_NAME` | 키워드1, 키워드2, 키워드3 | `COL1`, `COL2` | 설명 (N건) |
```

## Writing rules

- Group tables into practical domain categories inferred from names, columns, and key columns.
- Sort tables by row count descending within each category.
- Use natural Korean descriptions suitable for business users.
- Include Korean search keywords that a user might type in a chat UI.
- Prefer business-relevant columns and primary key columns as `주요 컬럼`.
- Omit sensitive columns such as `PASSWORD`, `PASS_HASH`, `PASSWD`, `PWD`, and `SECRET`.
- Keep Oracle table and column names exactly as provided, including uppercase names.

## Table detail requirements

For every table, add a `tables` entry using this Markdown structure:

```markdown
# TABLE_NAME

> **database**: `{{DB_DATABASE}}` | **건수**: N건

## 컬럼 목록

| 컬럼명 | 타입 | Null | Key | 설명 |
|--------|------|------|-----|------|
| `COLUMN_NAME` | VARCHAR2 | NOT NULL | PK | 한글 설명 |
| `AMOUNT` | NUMBER | NULL |  | 금액 |

## 관련 테이블

- 관련 외래키 관계 서술
```

Include all columns, omit sensitive columns such as `PASSWORD`, `PASS_HASH`, `PASSWD`, `PWD`, and `SECRET`, and preserve the exact Oracle table name (uppercase) in the heading and file key.

## Final reminder

Your response is consumed by a machine parser that calls `JSON.parse` on the raw text. Any character outside the single top-level JSON object — including a leading space before `{`, a trailing newline after `}` is fine, but any word, quote of your reasoning, apology, or markdown fence — will crash the pipeline. Return the JSON object and nothing else.
