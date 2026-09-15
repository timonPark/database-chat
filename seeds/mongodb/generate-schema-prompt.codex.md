# MongoDB schema index generation for Codex

You are generating user-facing Korean markdown files for a natural-language MongoDB chat app.

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
  "mapping": "complete markdown content for collection-mapping.md"
}
```

Both values must be strings. Escape newlines as `\n` and double quotes as needed so the entire response is parseable JSON.

## Input format

The schema is emitted as repeated blocks:

```text
[COLLECTION] collection_name | 123건
  field_name: string
  other_field: object
```

## index.md requirements

Create Korean markdown with this structure:

```markdown
# DB 컬렉션 인덱스
> **database**: `{{DB_DATABASE}}` — N개 컬렉션 / M건
> 최종 업데이트: {{TODAY}}

## 컬렉션 목록

### 카테고리명
| 컬렉션명 | 한글 설명 |
|---------|---------|
| `collection_name` | 설명 (123건) |

---

## 파일 구조

```text
collections/
├── collection_name.md    # 설명 (123건)
```
```

## collection-mapping.md requirements

Create Korean markdown with this structure:

```markdown
# 컬렉션 자연어 매핑 정의서

> **database**: `{{DB_DATABASE}}`

---

## 카테고리명

| 컬렉션명 | 자연어 키워드 | 주요 필드 | 설명 |
|---------|-------------|---------|------|
| `collection_name` | 키워드1, 키워드2, 키워드3 | `field1`, `field2` | 설명 (123건) |
```

## Writing rules

- Group collections into practical domain categories inferred from names and fields.
- Sort collections by document count descending within each category.
- Use natural Korean descriptions suitable for business users.
- Include Korean search keywords that a user might type in a chat UI.
- Prefer important fields from the schema as `주요 필드`; omit sensitive fields such as `password`, `passHash`, `passwd`, `pwd`, and `secret`.
- If a collection has no sampled fields, still include it with a useful description based on its name.
- Keep collection names exactly as provided.
