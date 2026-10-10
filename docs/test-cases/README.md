# 자연어 조회 테스트케이스 (결과 컬럼 매칭 검증)

운영체제(mac · Windows) × LLM provider(claude · codex · gemini) × DB(MySQL · PostgreSQL · Oracle · MSSQL · MongoDB) **30개 조합**을 같은 기준으로 검증하기 위한 케이스와 실행기입니다.

검증 대상은 서버가 조회 결과에 붙이는 컬럼 정보입니다 (`columns[].source` · `columnConfidence` · `unmappedKeys`). 화면에서는 표 헤더 라벨과 "일부 컬럼은 자동 매핑되지 않았습니다" 배지로 나타납니다.

- 에픽: #190 · 이 문서: #189 · 배경: #179 (Windows SQL 결과 컬럼 매칭 수정)

## 구성

```
docs/test-cases/
├── README.md          # 이 문서 — 판정 기준 · 실행 방법 · 조합 매트릭스
├── run-cases.mjs      # 실행기 (의존성 없음, Node 18+, mac · Windows 공통)
├── cases/
│   ├── <db>.json      # 케이스 원본 (실행기가 읽음)
│   └── <db>.md        # 사람이 읽는 케이스 목록 (JSON 에서 생성)
└── results/
    └── TEMPLATE.md    # 조합별 결과 기록 양식
```

## 1. 샘플 데이터

케이스는 **`npm run seed` 가 받아서 세팅하는 샘플 데이터** 기준입니다. 외부 DB 를 쓰는 경우에도 같은 데이터를 적재해야 케이스가 맞습니다.

| DB | 샘플 | seed 동작 | 케이스 |
|---|---|---|---|
| MySQL | Sakila (16 tables) | MySQL 공식 sakila-db.zip 적재, `DB_DATABASE=sakila` | [cases/mysql.md](cases/mysql.md) |
| PostgreSQL | dvdrental (15 tables, Sakila 계열) | PostgreSQL Tutorial dvdrental 복원, `DB_DATABASE=dvdrental` | [cases/postgresql.md](cases/postgresql.md) |
| Oracle | HR (7 tables) | oracle/db-sample-schemas human_resources, 계정 `hr` · SERVICE `FREEPDB1` | [cases/oracle.md](cases/oracle.md) |
| MSSQL | AdventureWorksLT2022 | Microsoft 공식 .bak 복원, 업무 테이블은 `SalesLT` 스키마 | [cases/mssql.md](cases/mssql.md) |
| MongoDB | sample.json (users · products · orders) | `seeds/mongodb/sample.json` 적재 | [cases/mongodb.md](cases/mongodb.md) |

`npm run seed` 는 `bash scripts/seed.sh` 를 실행합니다 (Docker 컨테이너 대상). Windows 에서는 Git Bash 와 Docker Desktop 이 필요합니다.

## 2. 판정 기준

### 라벨 문구가 아니라 `source` 로 판정한다

표 헤더 라벨은 `schema` 실행 때 **LLM 이 만든 설명 문구**라 provider 마다, 재생성할 때마다 바뀝니다 (예: `name` → "카테고리명" / "카테고리 이름 (영화 장르)"). 반면 `source` 는 컬럼이 매칭된 스키마 파일 이름이고, DB 테이블 이름에서 나오므로 바뀌지 않습니다.

| 필드 | 의미 | 예 |
|---|---|---|
| `columns[].source` | 컬럼이 매칭된 테이블 (= `tables/<이름>.md`, MongoDB 는 `collections/<이름>.md`). 미매칭이면 `null` | `film` · `EMPLOYEES` · `SalesLT.Product` |
| `columnConfidence` | 모든 컬럼이 매칭되면 `full`, 하나라도 미매칭이면 `partial` (배지 표시) | |
| `unmappedKeys` | 미매칭 컬럼 key | `film_count` |

- 테이블 이름 표기는 DB 를 따릅니다: Oracle 은 대문자 (`EMPLOYEES`), MSSQL 은 `<스키마>.<테이블>` (`SalesLT.Product`, `dbo.BuildVersion`)
- 결과 key 의 대소문자는 판정에서 무시합니다 (Oracle 은 결과 key 가 대문자로 옴)

### 결과 등급

| 등급 | 의미 |
|---|---|
| ✅ PASS | 기대와 일치 |
| ⚠️ REVIEW | 사람이 확인해야 함 — 대부분 LLM 이 만든 쿼리 차이 (예: 이름을 `CONCAT(first_name, ' ', last_name)` 으로 합쳐 계산 컬럼이 됨, 기대한 테이블 컬럼을 조회하지 않음) |
| ❌ FAIL | 잘못 매칭 (기대와 다른 테이블), 민감 컬럼 노출, 직접 쿼리 케이스의 기대 불일치, 서버 오류 |

### 케이스 종류

| 종류 | 보내는 곳 | 판정 |
|---|---|---|
| 직접 쿼리 (`D-xx`) | SQL: `POST /db-query {sql}` · MongoDB: `POST /db-query` (find) / `POST /db-aggregate` (pipeline) | 쿼리가 고정이라 **엄격 판정** — 컬럼별 source · confidence · 미매칭 목록이 정확히 일치해야 PASS |
| 자연어 (`TC-xx`) | `POST /chat {message}` | LLM 이 쿼리를 매번 다르게 만들므로 **느슨한 판정** — 매칭된 테이블이 기대 범위 안인지, 기대한 테이블이 한 번은 나오는지, 같은 이름 컬럼의 source 가 맞는지 |

자연어 케이스에서 LLM 이 별칭을 붙이면 (`c.name AS genre`) 컬럼 이름으로는 찾지 않고, 기대한 테이블(`category`) 로 매칭된 컬럼이 있는지로 확인합니다.

### 집계 · 계산 컬럼은 `partial` 이 정상

`COUNT(*) AS film_count`, `SUM(amount)`, `CONCAT(...)` 처럼 스키마에 없는 계산 컬럼은 미매칭이 맞습니다. 집계 케이스는 `partial` 을 기대합니다.

## 3. 실행 방법

### 공통 순서

1. DB 기동 · 샘플 적재 — `npm run seed` (또는 같은 데이터를 외부 DB 에 적재)
2. 스키마 생성 — Windows `schema.bat` / mac `npm run schema`
   - `index.md` · `table-mapping.md` 가 자리표시 상태면 LLM 이 없는 테이블을 지어내 자연어 케이스가 실패합니다
3. 서버 실행 — Windows `start.bat` / mac `npm start`, 콘솔에서 `스키마 인덱스 로드 완료: N/N` 확인
4. 실행기 실행 (이 저장소 루트에서)

```bash
node docs/test-cases/run-cases.mjs --db mysql --project <설치 폴더> --out docs/test-cases/results/windows-claude-mysql.md
```

| 옵션 | 설명 |
|---|---|
| `--db` | `mysql` · `postgresql` · `oracle` · `mssql` · `mongodb` |
| `--project <dir>` | 설치 폴더. `server.ts` 의 SQL 허용 규칙 (`WITH`) · `.env` 의 `PORT` · 모델명을 읽어 판정 · 보고서에 반영 (DB 접속 정보는 읽지 않음) |
| `--url` | 서버 주소 (기본: `--project` 의 PORT, 없으면 `http://localhost:3111`) |
| `--out <file.md>` | 결과 보고서 저장 |
| `--only D-01,TC-05` | 일부 케이스만 |
| `--skip-chat` / `--skip-direct` | 자연어 / 직접 쿼리 케이스 건너뛰기 |
| `--retry <n>` | 자연어 케이스가 LLM · DB 오류일 때 재시도 (기본 1) |
| `--list` | 케이스 목록을 마크다운으로 출력 |

종료 코드: FAIL 이 있으면 1, 없으면 0 (REVIEW 는 0).

### 직접 확인 (수동)

```powershell
# Windows PowerShell
$body = @{ sql = 'SELECT * FROM `film` LIMIT 5' } | ConvertTo-Json
$r = Invoke-RestMethod -Uri http://localhost:3111/db-query -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
$r.columnConfidence; $r.unmappedKeys; $r.columns | Format-Table key, source, label
```

```bash
# mac
curl -s http://localhost:3111/db-query -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT * FROM `film` LIMIT 5"}' | jq '{columnConfidence, unmappedKeys, columns: [.columns[] | {key, source}]}'
```

## 4. 조합 매트릭스

| DB | Windows | Mac | CTE (`WITH`) 서버 허용 | 비고 |
|---|---|---|---|---|
| MySQL | #191 | #196 | Windows claude · codex 허용 / Windows gemini · Mac 3종 거부 | |
| PostgreSQL | #192 | #197 | 전부 허용 | |
| Oracle | #193 | #198 | 전부 허용 | |
| MSSQL | #194 | #199 | 전부 허용 | 민감 컬럼 노출 (아래 알려진 문제) |
| MongoDB | #195 | #200 | 해당 없음 | |

- **CTE 케이스**는 템플릿의 `ALLOWED_SQL_PREFIXES` 에 따라 기대 결과가 다릅니다. `--project` 를 주면 실행기가 자동으로 판정합니다 (미허용 템플릿은 400 거부가 PASS)
- **Mac SQL 4종 (#196 ~ #199)** 은 #178 (mac 결과 컬럼 매칭 수정) 머지 후 진행합니다. 그 전에는 JOIN · 따옴표 · CTE 케이스가 실패합니다

### provider 별 쿼리 생성 경향 (#179 검증 때 관찰)

| provider | 경향 | 판정 영향 |
|---|---|---|
| 공통 | `LIMIT` 을 프롬프트 기본값(20)으로 고정, `*` 대신 컬럼 나열, 서브쿼리 대신 `LEFT JOIN … IS NULL` | 없음 |
| claude | 이름을 `CONCAT(first_name, ' ', last_name) AS manager_name` 으로 합침, `sakila.store` 처럼 DB 접두사 사용 | 계산 컬럼 → REVIEW |
| codex | `t1/t2/t3` 별칭, 상위 N 을 CTE + `ROW_NUMBER()` 로 생성, 이름 `CONCAT` | WITH 미허용 템플릿에서 실행 오류 가능 |
| gemini | 컬럼에 별칭 (`t3.name AS category_name`) | 없음 (별칭 인식) |

## 5. 결과 기록

1. 조합별로 실행기를 `--out docs/test-cases/results/<os>-<provider>-<db>.md` 로 실행
2. REVIEW 항목은 보고서 "상세" 의 실행 쿼리를 보고 판단해, [results/TEMPLATE.md](results/TEMPLATE.md) 형식으로 결론을 덧붙임
3. FAIL 은 원인 (수정 코드 · 스키마 파일 · LLM 쿼리) 을 분류하고, 버그면 별도 이슈로 분리
4. 해당 OS × DB 하위 이슈 (#191 ~ #200) 의 provider 체크리스트를 갱신

## 6. 케이스 추가 · 수정

`cases/<db>.json` 을 고친 뒤 마크다운 목록을 다시 생성합니다.

```bash
node docs/test-cases/run-cases.mjs --db mssql --list > docs/test-cases/cases/mssql.md
```

| 필드 | 대상 | 의미 |
|---|---|---|
| `expect.confidence` | 공통 | `full` / `partial` |
| `expect.sources` | 공통 | `{ key: 테이블 }` — 직접 쿼리는 해당 key 필수, 자연어는 key 가 있을 때만 확인하고 테이블 등장 여부는 항상 확인 |
| `expect.tables` | 자연어 | 매칭돼도 되는 테이블 목록 — 밖의 테이블로 매칭되면 FAIL |
| `expect.allowPartial` | 자연어 | `partial` 이어도 PASS 로 볼 사유 |
| `expect.allFrom` | 직접 | 모든 컬럼의 source |
| `expect.unmapped` / `unmappedIncludes` | 직접 | 미매칭 key 정확히 일치 / 포함 |
| `expect.keys` | 직접 | 결과 컬럼 key 목록 (0건 헤더 확인용) |
| `expect.count` | 공통 | 결과 건수 |
| `expect.absentKeys` | 공통 | 결과에 나오면 안 되는 key (민감 컬럼) |
| `cte: true` | 직접 | `WITH` 쿼리 — 미허용 템플릿은 400 거부를 기대 |

## 7. 알려진 문제 · 현재 설계

| 항목 | 내용 | 케이스 |
|---|---|---|
| **MSSQL 민감 컬럼 노출** | SQL 템플릿의 민감 컬럼 필터가 `password` · `pass_hash` · `passwd` · `pwd` · `secret` 과 **이름이 정확히 같을 때만** 제거 → AdventureWorksLT `SalesLT.Customer` 의 `PasswordHash` · `PasswordSalt` 가 노출됨 (오프라인 검증에서 FAIL 확인) | mssql `D-14` · `TC-03` |
| MongoDB `$project` | `$project` · `$group` · `$addFields` 등 형태를 바꾸는 stage 가 있으면 모든 key 가 매칭돼도 `partial` (현재 설계) | mongodb `D-08` · `TC-04` · `TC-05` |
| MongoDB `$lookup` 배열 | `$unwind` 없이 배열이면 해당 key 미매칭 (현재 설계) | mongodb `D-09` |
| `WITH` 허용 불일치 | 같은 provider · DB 라도 OS 에 따라 `WITH` 허용 여부가 다름 (MySQL) | 각 DB 의 CTE 케이스 |
