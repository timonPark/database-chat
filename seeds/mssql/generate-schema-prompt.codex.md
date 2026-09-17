# Microsoft SQL Server schema index generation for Codex

You are generating user-facing Korean markdown files for a natural-language Microsoft SQL Server chat app.

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
    "SalesLT.Product": "complete markdown content for tables/SalesLT.Product.md"
  }
}
```

The `index` and `mapping` values must be strings. Escape newlines as `\n` and double quotes as needed so the entire response is parseable JSON.
The `tables` value must contain one key for every table. Each key must be the exact schema-qualified table name (e.g. `SalesLT.Product`, `dbo.ErrorLog`) and each value must be the complete Markdown content for that table's detail file.

## Input format

The schema is emitted as repeated blocks:

```text
[TABLE] SalesLT.Product | 123건
  ProductID: int NOT NULL PK
  Name: nvarchar NOT NULL
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
| `SalesLT.Product` | 설명 (N건) |

---

## 파일 구조

```text
tables/
├── SalesLT.Product.md    # 설명 (N건)
```

---

## 컬럼 타입 규칙

- 날짜 컬럼 → datetime / date / datetime2
- 금액 컬럼 → decimal / money
- 식별자 컬럼 → int / bigint / uniqueidentifier
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
| `SalesLT.Product` | 키워드1, 키워드2, 키워드3 | `ProductID`, `Name` | 설명 (N건) |
```

## Writing rules

- SQL Server table names include the schema name, such as `SalesLT.Product` or `dbo.ErrorLog`; preserve that full name everywhere.
- File names in the file tree must also preserve the full schema-qualified table name, such as `tables/SalesLT.Product.md`.
- Group tables into practical domain categories inferred from schema names, table names, columns, and key columns.
- Sort tables by row count descending within each category.
- Use natural Korean descriptions suitable for business users.
- Include Korean search keywords that a user might type in a chat UI.
- Prefer business-relevant columns and primary key columns as `주요 컬럼`.
- Omit sensitive columns such as `password`, `pass_hash`, `passwd`, `pwd`, and `secret`.

## Table detail requirements

For every table, add a `tables` entry using this Markdown structure:

```markdown
# SalesLT.Product

> **database**: `{{DB_DATABASE}}` | **건수**: N건

## 컬럼 목록

| 컬럼명 | 타입 | Null | Key | 설명 |
|--------|------|------|-----|------|
| `ProductID` | int | NOT NULL | PK | 상품 식별자 |
| `Name` | nvarchar | NOT NULL |  | 상품명 |

## 관련 테이블

- 관련 외래키 관계 서술
```

Include all columns, omit sensitive columns such as `password`, `pass_hash`, `passwd`, `pwd`, and `secret`, and preserve the exact schema-qualified table name in the heading and file key (e.g. `SalesLT.Product`, not just `Product`).
