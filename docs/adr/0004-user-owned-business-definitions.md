---
status: accepted
---

# Business Definition 은 **사용자 소유 별도 파일**로 두고, 서버가 시스템 프롬프트에 **원문 그대로** 주입한다

LLM 은 컬럼 이름만으로는 "매출" 같은 지표의 계산식을 알 수 없어 질문마다 다르게 계산할 수 있다 (AdventureWorksLT 는 `LineTotal` · `SubTotal` · `TotalDue` 가 모두 후보). 사용자가 적는 Business Definition 을 Scaffolded Project 루트의 **`definitions.md`** 에 두고, 서버가 요청마다 읽어 시스템 프롬프트에 `[비즈니스 정의]` 섹션으로 그대로 넣는다. 파일이 없으면 섹션을 생략해 기존 동작과 같다. 이 결정은 #273 에픽의 구현 이슈들이 따르는 기준이다.

## 형식

서버는 내용을 파싱하지 않는다. 아래는 **권장 구조**일 뿐 검증하지 않으며, 정의 하나를 `###` 헤딩 하나로 쓰는 규칙만 권장한다 (적용된 정의를 표시하는 #277 에서 정의 단위로 나눌 수 있어야 한다).

```md
# 비즈니스 정의

## 지표

### 매출
취소 주문 (`SalesLT.SalesOrderHeader.Status = 6`) 을 제외한 `SalesLT.SalesOrderDetail.LineTotal` 의 합계.
`TotalDue` (세액·운송비 포함) 와 `SubTotal` 은 매출로 쓰지 않는다.

## 용어

### 거래처
`SalesLT.Customer.CompanyName`. 동의어: 고객사, 업체.
```

## 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| 파일 | Scaffolded Project 루트 `definitions.md` — 전 DB 공통 이름 | MongoDB 는 `collection-mapping.md` 라 DB 별 이름이 갈리지만, 정의는 DB 중립이다 |
| Schema Index 와 분리 | `index.md` · `table-mapping.md` · `tables/*.md` 를 편집하지 않는다 | 스키마 생성 스크립트 (전체 모드) 가 `index.md` · `table-mapping.md` 를 `rm -f` 후 LLM 으로 다시 쓰고, 재생성 대상 `tables/<이름>.md` 도 삭제 후 다시 쓴다. 손으로 고친 내용이 사라진다 |
| 주입 방식 | 파서 없이 원문 주입, 요청마다 읽기 | 서버가 `index.md` · `table-mapping.md` 를 요청마다 다시 읽는 방식과 같다. 파일을 고치면 서버 재시작 없이 반영된다 |
| 크기 상한 | **8,000자** (제안) — 초과분은 잘라내고 서버 로그에 경고 | 샘플 DB (12~16개 테이블) 기준 `index.md` + `table-mapping.md` 가 약 3,500자라, 정의가 스키마 정보보다 프롬프트를 크게 차지하지 않도록 그 2배 남짓으로 제한한다 |
| 충돌 시 우선순위 | Business Definition 이 `table-mapping.md` 의 자연어 키워드보다 우선 — 시스템 프롬프트에 명시 | 키워드는 자동 생성이라 틀릴 수 있고, 정의는 사람이 소유한다 |
| `table-mapping.md` 와의 역할 | `table-mapping.md` = 어느 **테이블**인가 (자동 생성), Business Definition = **무엇을 뜻하고 어떻게 계산**하는가 (사람) | Business Term 은 자동 키워드로 풀리지 않는 컬럼·업무 의미 수준에서만 적는다 |

## Considered Options

- **`table-mapping.md` 안에 편집 영역을 두고 재생성 시 보존** (거절): 스크립트가 파일을 삭제 후 LLM 이 다시 쓰므로 병합·보존 마커 로직이 필요하고, LLM 이 마커를 깨뜨릴 수 있다.
- **정의를 스키마 생성 입력으로 넣어 LLM 이 인덱스에 녹이게 함** (거절): 다시 생성하기 전에는 반영되지 않고, LLM 이 정의를 요약하다 계산식을 바꾸거나 빠뜨릴 수 있다.
- **YAML/JSON 구조화 + 서버 파서** (거절): 형식 오류 처리와 유지 비용이 생기는데 LLM 은 어떤 마크다운이든 읽는다. #277 에서 정의 단위 표시에 필요하면 재검토한다.
- **별도 파일 + 원문 주입** (채택): 가장 작고, 기존 로드 방식과 같으며, 생성 스크립트와 충돌하지 않는다.

## Consequences

- **ADR 0002 와의 관계**: 정의는 사용자가 쓴 텍스트이고 DB 값이 아니므로 "데이터 행 미주입" 원칙을 깨지 않는다. LLM 은 여전히 DB 에 접근하지 않고 서버의 `/db-query` 만 거친다.
- 정의 파일 내용은 **LLM provider 서버로 전송**된다. 비밀번호 · 개인정보 · 접속 정보를 적지 않는다 (사용자 안내 문서에 명시한다).
- 파일 형식을 검증하지 않으므로 정의를 잘못 써도 서버는 알려 주지 못한다. 대신 어떤 형식이든 동작한다.
- 스키마 생성 스크립트가 `definitions.md` 를 건드리지 않는다는 점은 스크립트 코드를 읽어 확인했고, 실제 재실행 검증은 #275 에서 한다.
- 적용한 정의 표시 (#277): 정의 이름은 `###` 헤딩 텍스트다. 서버는 정의 내용을 해석하지 않고, LLM 이 SQL JSON 에 `"applied":["정의 이름"]` 으로 보고한 이름 중 헤딩과 정확히 일치하는 것만 응답에 싣는다 (지어낸 이름은 버린다). 따라서 "적용했다" 는 LLM 의 자기 보고를 헤딩과 대조한 것이지, 서버가 Generated Query 를 분석해 증명한 것은 아니다.
- MongoDB 의 지표 정의는 aggregate pipeline 식이라 SQL 예시와 다르다. 형식을 강제하지 않으므로 같은 파일 · 같은 주입 방식을 쓰고, 예시는 SQL 템플릿 PoC 후 확인한다.
- PoC 는 `templates/mac/claude-mssql` 에서 먼저 검증한다. AdventureWorksLT 가 매출 후보 컬럼이 갈리는 (`LineTotal` · `SubTotal` · `TotalDue`) 지표 모호성 사례를 갖고 있어 정의 유무의 차이를 보이기 좋고, 회귀 케이스 29건 (`docs/test-cases/cases/mssql.md`) 이 정비돼 있어 기존 동작 회귀를 확인하기 쉽다.
