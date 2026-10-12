# mac · codex · mssql 테스트 결과

> 이슈: #199 · 검증표: #189 · 재측정: #227 (민감 컬럼 필터 수정 후)

## 결론

| 항목 | 내용 |
|---|---|
| 실행일 · 실행자 | 2026-10-12 · Claude Code |
| 설치 폴더 · 모델 | `codex-mssql` (저장소 루트, `main` 템플릿 + #227 `server.ts` · `build-columns.ts` 반영) · `gpt-5.6-luna` |
| 샘플 데이터 | README 1장 기준 — Docker SQL Server · `AdventureWorksLT2022` (SalesLT 10 + dbo 2 tables), `tables/*.md` 12/12 |
| 결과 | ✅ 27 · ⚠️ 0 · ❌ 0 (TC-07 · 08 · 09 재실행 반영) |
| 최종 판정 | 통과 |

## REVIEW · FAIL 항목

| ID | 등급 | 원인 분류 | 판단 · 조치 |
|---|---|---|---|
| TC-07 · TC-08 · TC-09 | (재실행 ✅) | 환경 (OpenAI 429) | 3종 동시 실행 중 codex CLI `429 Too Many Requests` 로 SQL 미생성 → 케이스 단독 재실행에서 모두 ✅ |

- #199 최초 실행에서 D-14 (3종) · TC-03 (codex) 가 ❌ — `PasswordHash` · `PasswordSalt` 노출. #227 수정 후 재측정
- 민감 컬럼: D-14 `SELECT TOP 5 * FROM SalesLT.Customer` · TC-03 `SELECT * FROM SalesLT.Customer` 모두 `PasswordHash` · `PasswordSalt` 미노출
- MSSQL 필수 케이스: `FROM SalesLT.t` (D-01) · `[SalesLT].[t]` (D-02) · `dbo.t` (D-03) · 접두사 없는 `FROM t` (D-04) · 3-part 이름 (D-06) · `WITH (NOLOCK)` (D-08) · `별칭 = 컬럼` (D-09) · CTE (D-13) 모두 PASS

## 실행기 보고서

`node docs/test-cases/run-cases.mjs --db mssql --project codex-mssql --url http://localhost:3112 --out docs/test-cases/results/mac-codex-mssql.md`

> 3종을 포트만 나눠 (`PORT=3111` · `3112` · `3113`) 동시에 실행

- 실행: 2026-10-12T08:10:39.337Z · OS: darwin · 서버: http://localhost:3112
- 설치 폴더: `~/Project/database-chat/codex-mssql` · provider: codex · 모델: gpt-5.6-luna · WITH 허용: true
- 샘플 데이터: AdventureWorksLT2022
- 결과: ✅ 24 · ⚠️ 0 · ❌ 3 (총 27)

| ID | 구분 | 결과 | confidence | 미매칭 | 비고 |
|---|---|---|---|---|---|
| D-01 | 스키마 접두사 | ✅ | full |  |  |
| D-02 | 대괄호 식별자 | ✅ | full |  |  |
| D-03 | dbo 접두사 | ✅ | full |  |  |
| D-04 | 접두사 생략 (기본 스키마 dbo) | ✅ | full |  |  |
| D-05 | 공백 포함 컬럼 | ✅ | full |  |  |
| D-06 | 3-part 이름 | ✅ | full |  |  |
| D-07 | JOIN · 동명 컬럼 (별칭) | ✅ | full |  |  |
| D-08 | JOIN alias.* · NOLOCK | ✅ | full |  |  |
| D-09 | MSSQL 별칭 = 컬럼 · 소문자 참조 | ✅ | full |  |  |
| D-10 | 콤마 조인 | ✅ | full |  |  |
| D-11 | 집계 | ✅ | partial | ProductCount |  |
| D-12 | 결과 0건 헤더 | ✅ | full |  |  |
| D-13 | CTE | ✅ | full |  |  |
| D-14 | 민감 컬럼 | ✅ | full |  |  |
| TC-01 | 회귀 | ✅ | full |  |  |
| TC-02 | 회귀 | ✅ | full |  |  |
| TC-03 | 회귀 · 민감 컬럼 | ✅ | full |  |  |
| TC-04 | 회귀 · 서브쿼리 | ✅ | full |  |  |
| TC-05 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| TC-06 | JOIN (상대 컬럼만) | ✅ | full |  |  |
| TC-07 | JOIN | ❌ | — |  | 결과 없음 — Codex 프로세스 실행 실패: Reading additional input from stdin... OpenAI Codex v0.162.0-alpha.17.2 -------- workdir: /private/var/folders/84/3p4cf9z106b5fmv1wv2_w9k00000gn/T/dbchat-cli-nS4E3y model: gpt-5.6-luna provider: opena |
| TC-08 | JOIN | ❌ | — |  | 결과 없음 — Codex 프로세스 실행 실패: Reading additional input from stdin... OpenAI Codex v0.162.0-alpha.17.2 -------- workdir: /private/var/folders/84/3p4cf9z106b5fmv1wv2_w9k00000gn/T/dbchat-cli-nS4E3y model: gpt-5.6-luna provider: opena |
| TC-09 | JOIN (3개 테이블) | ❌ | — |  | 결과 없음 — Codex 프로세스 실행 실패: Reading additional input from stdin... OpenAI Codex v0.162.0-alpha.17.2 -------- workdir: /private/var/folders/84/3p4cf9z106b5fmv1wv2_w9k00000gn/T/dbchat-cli-nS4E3y model: gpt-5.6-luna provider: opena |
| TC-10 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| TC-11 | 집계 | ✅ | partial | ProductCount |  |
| TC-12 | 집계 · JOIN | ✅ | partial | TotalOrderAmount |  |
| TC-13 | 결과 0건 | ✅ | full |  |  |

## 상세

### D-01 ✅ 스키마 접두사
- 실행 쿼리: `SELECT TOP 5 * FROM SalesLT.Product`
- 컬럼: ProductID→SalesLT.Product, Name→SalesLT.Product, ProductNumber→SalesLT.Product, Color→SalesLT.Product, StandardCost→SalesLT.Product, ListPrice→SalesLT.Product, Size→SalesLT.Product, Weight→SalesLT.Product, ProductCategoryID→SalesLT.Product, ProductModelID→SalesLT.Product, SellStartDate→SalesLT.Product, SellEndDate→SalesLT.Product, DiscontinuedDate→SalesLT.Product, ThumbNailPhoto→SalesLT.Product, ThumbnailPhotoFileName→SalesLT.Product, rowguid→SalesLT.Product, ModifiedDate→SalesLT.Product

### D-02 ✅ 대괄호 식별자
- 실행 쿼리: `SELECT TOP 5 * FROM [SalesLT].[Product]`
- 컬럼: ProductID→SalesLT.Product, Name→SalesLT.Product, ProductNumber→SalesLT.Product, Color→SalesLT.Product, StandardCost→SalesLT.Product, ListPrice→SalesLT.Product, Size→SalesLT.Product, Weight→SalesLT.Product, ProductCategoryID→SalesLT.Product, ProductModelID→SalesLT.Product, SellStartDate→SalesLT.Product, SellEndDate→SalesLT.Product, DiscontinuedDate→SalesLT.Product, ThumbNailPhoto→SalesLT.Product, ThumbnailPhotoFileName→SalesLT.Product, rowguid→SalesLT.Product, ModifiedDate→SalesLT.Product

### D-03 ✅ dbo 접두사
- 실행 쿼리: `SELECT * FROM dbo.BuildVersion`
- 컬럼: SystemInformationID→dbo.BuildVersion, Database Version→dbo.BuildVersion, VersionDate→dbo.BuildVersion, ModifiedDate→dbo.BuildVersion

### D-04 ✅ 접두사 생략 (기본 스키마 dbo)
- 실행 쿼리: `SELECT * FROM BuildVersion`
- 컬럼: SystemInformationID→dbo.BuildVersion, Database Version→dbo.BuildVersion, VersionDate→dbo.BuildVersion, ModifiedDate→dbo.BuildVersion

### D-05 ✅ 공백 포함 컬럼
- 실행 쿼리: `SELECT [Database Version], VersionDate FROM dbo.BuildVersion`
- 컬럼: Database Version→dbo.BuildVersion, VersionDate→dbo.BuildVersion

### D-06 ✅ 3-part 이름
- 실행 쿼리: `SELECT TOP 5 ProductID, Name FROM AdventureWorksLT2022.SalesLT.Product`
- 컬럼: ProductID→SalesLT.Product, Name→SalesLT.Product

### D-07 ✅ JOIN · 동명 컬럼 (별칭)
- 실행 쿼리: `SELECT TOP 5 p.Name, c.Name AS CategoryName FROM SalesLT.Product p JOIN SalesLT.ProductCategory c ON c.ProductCategoryID = p.ProductCategoryID`
- 컬럼: Name→SalesLT.Product, CategoryName→SalesLT.ProductCategory

### D-08 ✅ JOIN alias.* · NOLOCK
- 실행 쿼리: `SELECT TOP 5 c.* FROM SalesLT.Product p WITH (NOLOCK) JOIN SalesLT.ProductCategory c ON c.ProductCategoryID = p.ProductCategoryID`
- 컬럼: ProductCategoryID→SalesLT.ProductCategory, ParentProductCategoryID→SalesLT.ProductCategory, Name→SalesLT.ProductCategory, rowguid→SalesLT.ProductCategory, ModifiedDate→SalesLT.ProductCategory

### D-09 ✅ MSSQL 별칭 = 컬럼 · 소문자 참조
- 실행 쿼리: `SELECT TOP 5 Product = p.name, price = p.listprice FROM SalesLT.Product p`
- 컬럼: Product→SalesLT.Product, price→SalesLT.Product

### D-10 ✅ 콤마 조인
- 실행 쿼리: `SELECT TOP 5 h.SalesOrderNumber, c.CompanyName FROM SalesLT.SalesOrderHeader h, SalesLT.Customer c WHERE c.CustomerID = h.CustomerID`
- 컬럼: SalesOrderNumber→SalesLT.SalesOrderHeader, CompanyName→SalesLT.Customer

### D-11 ✅ 집계
- 실행 쿼리: `SELECT Color, COUNT(*) AS ProductCount FROM SalesLT.Product GROUP BY Color`
- 컬럼: Color→SalesLT.Product, ProductCount→미매칭

### D-12 ✅ 결과 0건 헤더
- 실행 쿼리: `SELECT Name, ListPrice FROM SalesLT.Product WHERE 1 = 0`
- 컬럼: Name→SalesLT.Product, ListPrice→SalesLT.Product

### D-13 ✅ CTE
- 실행 쿼리: `WITH cat AS (SELECT ProductCategoryID, Name FROM SalesLT.ProductCategory) SELECT TOP 5 p.Name, p.ListPrice FROM SalesLT.Product p JOIN cat ON cat.ProductCategoryID = p.ProductCategoryID`
- 컬럼: Name→SalesLT.Product, ListPrice→SalesLT.Product

### D-14 ✅ 민감 컬럼
- 실행 쿼리: `SELECT TOP 5 * FROM SalesLT.Customer`
- 컬럼: CustomerID→SalesLT.Customer, NameStyle→SalesLT.Customer, Title→SalesLT.Customer, FirstName→SalesLT.Customer, MiddleName→SalesLT.Customer, LastName→SalesLT.Customer, Suffix→SalesLT.Customer, CompanyName→SalesLT.Customer, SalesPerson→SalesLT.Customer, EmailAddress→SalesLT.Customer, Phone→SalesLT.Customer, rowguid→SalesLT.Customer, ModifiedDate→SalesLT.Customer

### TC-01 ✅ 회귀
- 질문: 상품 목록 5개 보여줘
- 실행 쿼리: `SELECT TOP 5 ProductID, Name, ProductNumber, Color, StandardCost, ListPrice, Size, Weight, ProductCategoryID, ProductModelID FROM SalesLT.Product ORDER BY ProductID`
- 컬럼: ProductID→SalesLT.Product, Name→SalesLT.Product, ProductNumber→SalesLT.Product, Color→SalesLT.Product, StandardCost→SalesLT.Product, ListPrice→SalesLT.Product, Size→SalesLT.Product, Weight→SalesLT.Product, ProductCategoryID→SalesLT.Product, ProductModelID→SalesLT.Product

### TC-02 ✅ 회귀
- 질문: 정가가 가장 비싼 상품 10개의 이름과 가격 보여줘
- 실행 쿼리: `SELECT TOP 10 Name, ListPrice FROM SalesLT.Product ORDER BY ListPrice DESC`
- 컬럼: Name→SalesLT.Product, ListPrice→SalesLT.Product

### TC-03 ✅ 회귀 · 민감 컬럼
- 질문: 고객 정보 전부 보여줘
- 실행 쿼리: `SELECT * FROM SalesLT.Customer`
- 컬럼: CustomerID→SalesLT.Customer, NameStyle→SalesLT.Customer, Title→SalesLT.Customer, FirstName→SalesLT.Customer, MiddleName→SalesLT.Customer, LastName→SalesLT.Customer, Suffix→SalesLT.Customer, CompanyName→SalesLT.Customer, SalesPerson→SalesLT.Customer, EmailAddress→SalesLT.Customer, Phone→SalesLT.Customer, rowguid→SalesLT.Customer, ModifiedDate→SalesLT.Customer

### TC-04 ✅ 회귀 · 서브쿼리
- 질문: 한 번도 주문되지 않은 상품 알려줘
- 실행 쿼리: `SELECT p.ProductID, p.Name, p.ProductNumber, p.Color, p.Size, p.StandardCost, p.ListPrice, p.ProductCategoryID, p.ProductModelID FROM SalesLT.Product AS p WHERE NOT EXISTS (SELECT 1 FROM SalesLT.SalesOrderDetail AS d WHERE d.ProductID = p.ProductID) ORDER BY p.ProductID`
- 컬럼: ProductID→SalesLT.Product, Name→SalesLT.Product, ProductNumber→SalesLT.Product, Color→SalesLT.Product, Size→SalesLT.Product, StandardCost→SalesLT.Product, ListPrice→SalesLT.Product, ProductCategoryID→SalesLT.Product, ProductModelID→SalesLT.Product

### TC-05 ✅ JOIN · 동명 컬럼
- 질문: 상품 이름과 카테고리 이름 보여줘
- 실행 쿼리: `SELECT TOP 20 p.Name, pc.Name FROM SalesLT.Product AS p JOIN SalesLT.ProductCategory AS pc ON p.ProductCategoryID = pc.ProductCategoryID ORDER BY p.Name`
- 컬럼: Name→SalesLT.Product

### TC-06 ✅ JOIN (상대 컬럼만)
- 질문: Road Bikes 카테고리에 속한 상품 이름과 가격 알려줘
- 실행 쿼리: `SELECT p.Name, p.ListPrice FROM SalesLT.Product AS p JOIN SalesLT.ProductCategory AS t1 ON p.ProductCategoryID = t1.ProductCategoryID WHERE t1.Name = 'Road Bikes' ORDER BY p.Name`
- 컬럼: Name→SalesLT.Product, ListPrice→SalesLT.Product

### TC-07 ❌ JOIN
- 질문: 주문 번호, 주문일, 고객 회사명 보여줘
- 컬럼: —

### TC-08 ❌ JOIN
- 질문: 주문 상세 내역을 상품 이름과 같이 보여줘
- 컬럼: —

### TC-09 ❌ JOIN (3개 테이블)
- 질문: 고객 회사명과 주소의 도시 보여줘
- 컬럼: —

### TC-10 ✅ JOIN · 동명 컬럼
- 질문: 상품 이름과 상품 모델 이름 보여줘
- 실행 쿼리: `SELECT p.Name, pm.Name FROM SalesLT.Product AS p JOIN SalesLT.ProductModel AS pm ON p.ProductModelID = pm.ProductModelID ORDER BY p.ProductID`
- 컬럼: Name→SalesLT.Product

### TC-11 ✅ 집계
- 질문: 카테고리별 상품 수 알려줘
- 실행 쿼리: `SELECT c.ProductCategoryID, c.Name, COUNT(p.ProductID) AS ProductCount FROM SalesLT.ProductCategory AS c LEFT JOIN SalesLT.Product AS p ON c.ProductCategoryID = p.ProductCategoryID GROUP BY c.ProductCategoryID, c.Name ORDER BY ProductCount DESC`
- 컬럼: ProductCategoryID→SalesLT.ProductCategory, Name→SalesLT.ProductCategory, ProductCount→미매칭

### TC-12 ✅ 집계 · JOIN
- 질문: 주문 총액이 가장 큰 고객 회사 5곳 보여줘
- 실행 쿼리: `SELECT TOP 5 c.CustomerID, c.CompanyName, SUM(h.TotalDue) AS TotalOrderAmount FROM SalesLT.Customer AS c INNER JOIN SalesLT.SalesOrderHeader AS h ON c.CustomerID = h.CustomerID GROUP BY c.CustomerID, c.CompanyName ORDER BY SUM(h.TotalDue) DESC`
- 컬럼: CustomerID→SalesLT.Customer, CompanyName→SalesLT.Customer, TotalOrderAmount→미매칭

### TC-13 ✅ 결과 0건
- 질문: 정가가 100만 이상인 상품 이름 보여줘
- 실행 쿼리: `SELECT TOP 20 Name FROM SalesLT.Product WHERE ListPrice >= 1000000 ORDER BY ListPrice DESC`
- 컬럼: Name→SalesLT.Product

### 재실행 (TC-07, 429 이후)

`node docs/test-cases/run-cases.mjs --db mssql --project codex-mssql --url http://localhost:3112 --skip-direct --only TC-07`

- 실행: 2026-10-12T08:12:18.690Z · OS: darwin · 서버: http://localhost:3112
- 설치 폴더: `~/Project/database-chat/codex-mssql` · provider: codex · 모델: gpt-5.6-luna · WITH 허용: true
- 샘플 데이터: AdventureWorksLT2022
- 결과: ✅ 1 · ⚠️ 0 · ❌ 0 (총 1)

| ID | 구분 | 결과 | confidence | 미매칭 | 비고 |
|---|---|---|---|---|---|
| TC-07 | JOIN | ✅ | full |  | SalesOrderNumber 컬럼 없음 (별칭 · 생략) |

## 상세

### TC-07 ✅ JOIN
- 질문: 주문 번호, 주문일, 고객 회사명 보여줘
- 실행 쿼리: `SELECT TOP 20 t1.SalesOrderID, t1.OrderDate, t2.CompanyName FROM SalesLT.SalesOrderHeader AS t1 JOIN SalesLT.Customer AS t2 ON t1.CustomerID = t2.CustomerID ORDER BY t1.OrderDate DESC`
- 컬럼: SalesOrderID→SalesLT.SalesOrderHeader, OrderDate→SalesLT.SalesOrderHeader, CompanyName→SalesLT.Customer

### 재실행 (TC-08, 429 이후)

`node docs/test-cases/run-cases.mjs --db mssql --project codex-mssql --url http://localhost:3112 --skip-direct --only TC-08`

- 실행: 2026-10-12T08:11:21.925Z · OS: darwin · 서버: http://localhost:3112
- 설치 폴더: `~/Project/database-chat/codex-mssql` · provider: codex · 모델: gpt-5.6-luna · WITH 허용: true
- 샘플 데이터: AdventureWorksLT2022
- 결과: ✅ 1 · ⚠️ 0 · ❌ 0 (총 1)

| ID | 구분 | 결과 | confidence | 미매칭 | 비고 |
|---|---|---|---|---|---|
| TC-08 | JOIN | ✅ | full |  |  |

## 상세

### TC-08 ✅ JOIN
- 질문: 주문 상세 내역을 상품 이름과 같이 보여줘
- 실행 쿼리: `SELECT TOP 20 t1.SalesOrderID, t1.SalesOrderDetailID, t1.OrderQty, t1.ProductID, t1.UnitPrice, t1.UnitPriceDiscount, t1.LineTotal, t2.Name FROM SalesLT.SalesOrderDetail AS t1 INNER JOIN SalesLT.Product AS t2 ON t1.ProductID = t2.ProductID ORDER BY t1.SalesOrderID, t1.SalesOrderDetailID`
- 컬럼: SalesOrderID→SalesLT.SalesOrderDetail, SalesOrderDetailID→SalesLT.SalesOrderDetail, OrderQty→SalesLT.SalesOrderDetail, ProductID→SalesLT.SalesOrderDetail, UnitPrice→SalesLT.SalesOrderDetail, UnitPriceDiscount→SalesLT.SalesOrderDetail, LineTotal→SalesLT.SalesOrderDetail, Name→SalesLT.Product

### 재실행 (TC-09, 429 이후)

`node docs/test-cases/run-cases.mjs --db mssql --project codex-mssql --url http://localhost:3112 --skip-direct --only TC-09`

- 실행: 2026-10-12T08:11:46.534Z · OS: darwin · 서버: http://localhost:3112
- 설치 폴더: `~/Project/database-chat/codex-mssql` · provider: codex · 모델: gpt-5.6-luna · WITH 허용: true
- 샘플 데이터: AdventureWorksLT2022
- 결과: ✅ 1 · ⚠️ 0 · ❌ 0 (총 1)

| ID | 구분 | 결과 | confidence | 미매칭 | 비고 |
|---|---|---|---|---|---|
| TC-09 | JOIN (3개 테이블) | ✅ | full |  |  |

## 상세

### TC-09 ✅ JOIN (3개 테이블)
- 질문: 고객 회사명과 주소의 도시 보여줘
- 실행 쿼리: `SELECT c.CompanyName, a.City FROM SalesLT.Customer AS c INNER JOIN SalesLT.CustomerAddress AS ca ON c.CustomerID = ca.CustomerID INNER JOIN SalesLT.Address AS a ON ca.AddressID = a.AddressID`
- 컬럼: CompanyName→SalesLT.Customer, City→SalesLT.Address
