# MongoDB 스키마 인덱스 생성

아래는 MongoDB 데이터베이스 `{{DB_DATABASE}}`의 컬렉션 정보입니다:

```
{{SCHEMA}}
```

위 정보를 분석해서 아래 파일들을 **bash heredoc으로 현재 디렉토리에 직접 작성**하세요.

## 생성할 파일

1. `index.md` — 전체 컬렉션 인덱스 + 파일 트리 구조
2. `collection-mapping.md` — 자연어 키워드 매핑
3. `collections/<컬렉션명>.md` — 컬렉션별 필드 상세 명세 (각 컬렉션마다 개별 파일)

## index.md 형식

```
# DB 컬렉션 인덱스
> **database**: `{{DB_DATABASE}}` — N개 컬렉션 / M건
> 최종 업데이트: {{TODAY}}

## 컬렉션 목록

### 카테고리명
| 컬렉션명 | 한글 설명 |
|---------|---------|
| `컬렉션명` | 설명 (N건) |

---

## 파일 구조

```
collections/
├── collection1.md       # 설명 (N건)
├── collection2.md       # 설명 (N건)
```
```

## collection-mapping.md 형식

```
# 컬렉션 자연어 매핑 정의서

> **database**: `{{DB_DATABASE}}`

---

## 카테고리명

| 컬렉션명 | 자연어 키워드 | 주요 필드 | 설명 |
|---------|-------------|---------|------|
| `컬렉션명` | 키워드1, 키워드2 | `field1`, `field2` | 설명 (N건) |
```

## collections/<컬렉션명>.md 형식

```
# 컬렉션명

> **database**: `{{DB_DATABASE}}` | **건수**: N건

## 필드 목록

| 필드명 | 타입 | 설명 |
|--------|------|------|
| `_id` | ObjectId | 고유 식별자 |
| `field_name` | string | 한글 설명 |

## 관련 컬렉션

- 관련 참조 관계 서술
```

## 작성 지침

- 컬렉션을 도메인별로 카테고리화하세요
- 한국어 키워드는 자연어 채팅 검색에 적합하게 작성하세요
- 건수 기준 내림차순으로 정렬하세요
- 각 필드의 한글 설명은 필드명과 타입을 참고해 자연스럽게 작성하세요

## 파일 저장 방법

```bash
mkdir -p collections

cat > index.md << 'EOF'
(내용)
EOF

cat > collection-mapping.md << 'EOF'
(내용)
EOF

# 각 컬렉션마다 반복
cat > collections/컬렉션명.md << 'EOF'
(내용)
EOF
```
