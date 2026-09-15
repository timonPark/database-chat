# MySQL schema index generation for Codex

You are generating user-facing Korean markdown files for a natural-language MySQL chat app.

Analyze the schema below and return exactly one valid JSON object. Do not wrap it in markdown fences. Do not add commentary before or after the JSON.

Schema source:

```text
{{SCHEMA}}
```

Database name: `{{DB_DATABASE}}`
Last updated: `{{TODAY}}`

## Required JSON shape

```json
{
  "index": "complete markdown content for index.md",
  "mapping": "complete markdown content for table-mapping.md",
  "tables": {
    "table_name": "complete markdown content for tables/table_name.md"
  }
}
```

The `index` and `mapping` values must be strings. Escape newlines as `\n` and double quotes as needed so the entire response is parseable JSON.
The `tables` value must contain one key for every table. Each key must be the exact table name and each value must be the complete Markdown content for that table's detail file.

## Input format

The schema is emitted as repeated blocks:

```text
[TABLE] table_name | 123건
  column_name: varchar(45) NOT NULL PRI
  amount: decimal(10,2) NULL
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
| `table_name` | 설명 (123건) |

---

## 파일 구조

```text
tables/
├── table_name.md    # 설명 (123건)
```

---

## 컬럼 타입 규칙

- 날짜 컬럼 → DATETIME / DATE / TIMESTAMP
- 금액 컬럼 → DECIMAL
- 식별자 컬럼 → INT / BIGINT / VARCHAR
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
| `table_name` | 키워드1, 키워드2, 키워드3 | `col1`, `col2` | 설명 (123건) |
```

## Writing rules

- Group tables into practical domain categories inferred from names, columns, and key columns.
- Sort tables by row count descending within each category.
- Use natural Korean descriptions suitable for business users.
- Include Korean search keywords that a user might type in a chat UI.
- Prefer business-relevant columns and primary/foreign key columns as `주요 컬럼`.
- Omit sensitive columns such as `password`, `pass_hash`, `passwd`, `pwd`, and `secret`.
- Keep table and column names exactly as provided.

## Table detail requirements

For every table, add a `tables` entry using this Markdown structure:

```markdown
# table_name

> **database**: `{{DB_DATABASE}}` | **건수**: 123건

## 컬럼 목록

| 컬럼명 | 타입 | Null | Key | 설명 |
|--------|------|------|-----|------|
| `col_name` | varchar(45) | NO | PRI | 한글 설명 |

## 관련 테이블

- 관련 외래키 관계 서술
```

Include all columns, omit sensitive columns such as `password`, `pass_hash`, `passwd`, `pwd`, and `secret`, and preserve the exact table name in the heading and file key.
