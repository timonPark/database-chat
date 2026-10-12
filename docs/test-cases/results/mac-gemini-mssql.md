# mac · gemini · mssql 테스트 결과

> 이슈: #199 · 검증표: #189

## 결론

| 항목 | 내용 |
|---|---|
| 실행일 · 실행자 | 2026-10-12 · Claude Code |
| 설치 폴더 · 모델 | `gemini-mssql` (저장소 루트, `main` 템플릿 기준 — 매칭 스크립트 · server.ts 동일) · `gemini-3.8-flash-medium` |
| 샘플 데이터 | README 1장 기준 — Docker SQL Server · `AdventureWorksLT2022` (SalesLT 10 + dbo 2 tables), `tables/*.md` 12/12 |
| 결과 | ✅ 26 · ⚠️ 0 · ❌ 1 |
| 최종 판정 | 결과 컬럼 매칭 통과 · 민감 컬럼 노출 실패 (#227) |

## REVIEW · FAIL 항목

| ID | 등급 | 원인 분류 | 판단 · 조치 |
|---|---|---|---|
| D-14 | ❌ | 서버 설정 (민감 컬럼 필터) | `SELECT TOP 5 * FROM SalesLT.Customer` → `PasswordHash` · `PasswordSalt` 노출. 필터가 이름 정확 일치만 검사 (README 7장 알려진 문제) → #227 |

- MSSQL 필수 케이스: `FROM SalesLT.t` (D-01) · `[SalesLT].[t]` (D-02) · `dbo.t` (D-03) · 접두사 없는 `FROM t` (D-04) · 3-part 이름 (D-06) · `WITH (NOLOCK)` (D-08) · `별칭 = 컬럼` (D-09) · CTE (D-13) 모두 PASS

## 실행기 보고서

`node docs/test-cases/run-cases.mjs --db mssql --project gemini-mssql --url http://localhost:3113 --out docs/test-cases/results/mac-gemini-mssql.md`

> 3종을 포트만 나눠 (`PORT=3111` · `3112` · `3113`) 동시에 실행

- 실행: 2026-10-12T07:59:35.210Z · OS: darwin · 서버: http://localhost:3113
- 설치 폴더: `~/Project/database-chat/gemini-mssql` · provider: gemini · 모델: gemini-3.8-flash-medium · WITH 허용: true
- 샘플 데이터: AdventureWorksLT2022
- 결과: ✅ 26 · ⚠️ 0 · ❌ 1 (총 27)

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
| D-14 | 민감 컬럼 | ❌ | full |  | 민감 컬럼 PasswordHash 가 결과에 노출됨 / 민감 컬럼 PasswordSalt 가 결과에 노출됨 |
| TC-01 | 회귀 | ✅ | full |  |  |
| TC-02 | 회귀 | ✅ | full |  |  |
| TC-03 | 회귀 · 민감 컬럼 | ✅ | full |  |  |
| TC-04 | 회귀 · 서브쿼리 | ✅ | full |  |  |
| TC-05 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| TC-06 | JOIN (상대 컬럼만) | ✅ | full |  |  |
| TC-07 | JOIN | ✅ | full |  |  |
| TC-08 | JOIN | ✅ | full |  |  |
| TC-09 | JOIN (3개 테이블) | ✅ | full |  |  |
| TC-10 | JOIN · 동명 컬럼 | ✅ | full |  | Name 컬럼 없음 (별칭 · 생략) |
| TC-11 | 집계 | ✅ | partial | ProductCount |  |
| TC-12 | 집계 · JOIN | ✅ | partial | TotalDue |  |
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

### D-14 ❌ 민감 컬럼
- 실행 쿼리: `SELECT TOP 5 * FROM SalesLT.Customer`
- 컬럼: CustomerID→SalesLT.Customer, NameStyle→SalesLT.Customer, Title→SalesLT.Customer, FirstName→SalesLT.Customer, MiddleName→SalesLT.Customer, LastName→SalesLT.Customer, Suffix→SalesLT.Customer, CompanyName→SalesLT.Customer, SalesPerson→SalesLT.Customer, EmailAddress→SalesLT.Customer, Phone→SalesLT.Customer, PasswordHash→SalesLT.Customer, PasswordSalt→SalesLT.Customer, rowguid→SalesLT.Customer, ModifiedDate→SalesLT.Customer

### TC-01 ✅ 회귀
- 질문: 상품 목록 5개 보여줘
- 실행 쿼리: `SELECT TOP 5 ProductID, Name, ProductNumber, Color, StandardCost, ListPrice, ProductCategoryID FROM SalesLT.Product ORDER BY ProductID`
- 컬럼: ProductID→SalesLT.Product, Name→SalesLT.Product, ProductNumber→SalesLT.Product, Color→SalesLT.Product, StandardCost→SalesLT.Product, ListPrice→SalesLT.Product, ProductCategoryID→SalesLT.Product

### TC-02 ✅ 회귀
- 질문: 정가가 가장 비싼 상품 10개의 이름과 가격 보여줘
- 실행 쿼리: `SELECT TOP 10 Name, ListPrice FROM SalesLT.Product ORDER BY ListPrice DESC`
- 컬럼: Name→SalesLT.Product, ListPrice→SalesLT.Product

### TC-03 ✅ 회귀 · 민감 컬럼
- 질문: 고객 정보 전부 보여줘
- 실행 쿼리: `SELECT CustomerID, NameStyle, Title, FirstName, MiddleName, LastName, Suffix, CompanyName, SalesPerson, EmailAddress, Phone FROM SalesLT.Customer`
- 컬럼: CustomerID→SalesLT.Customer, NameStyle→SalesLT.Customer, Title→SalesLT.Customer, FirstName→SalesLT.Customer, MiddleName→SalesLT.Customer, LastName→SalesLT.Customer, Suffix→SalesLT.Customer, CompanyName→SalesLT.Customer, SalesPerson→SalesLT.Customer, EmailAddress→SalesLT.Customer, Phone→SalesLT.Customer

### TC-04 ✅ 회귀 · 서브쿼리
- 질문: 한 번도 주문되지 않은 상품 알려줘
- 실행 쿼리: `SELECT t1.ProductID, t1.Name, t1.ProductNumber, t1.ListPrice, t1.StandardCost, t1.Color FROM SalesLT.Product t1 LEFT JOIN SalesLT.SalesOrderDetail t2 ON t1.ProductID = t2.ProductID WHERE t2.ProductID IS NULL ORDER BY t1.ProductID`
- 컬럼: ProductID→SalesLT.Product, Name→SalesLT.Product, ProductNumber→SalesLT.Product, ListPrice→SalesLT.Product, StandardCost→SalesLT.Product, Color→SalesLT.Product

### TC-05 ✅ JOIN · 동명 컬럼
- 질문: 상품 이름과 카테고리 이름 보여줘
- 실행 쿼리: `SELECT t1.Name, t2.Name FROM SalesLT.Product t1 JOIN SalesLT.ProductCategory t2 ON t1.ProductCategoryID = t2.ProductCategoryID`
- 컬럼: Name→SalesLT.Product

### TC-06 ✅ JOIN (상대 컬럼만)
- 질문: Road Bikes 카테고리에 속한 상품 이름과 가격 알려줘
- 실행 쿼리: `SELECT t1.Name, t1.ListPrice FROM SalesLT.Product t1 INNER JOIN SalesLT.ProductCategory t2 ON t1.ProductCategoryID = t2.ProductCategoryID WHERE t2.Name = 'Road Bikes'`
- 컬럼: Name→SalesLT.Product, ListPrice→SalesLT.Product

### TC-07 ✅ JOIN
- 질문: 주문 번호, 주문일, 고객 회사명 보여줘
- 실행 쿼리: `SELECT TOP 20 t1.SalesOrderNumber, t1.OrderDate, t2.CompanyName FROM SalesLT.SalesOrderHeader t1 JOIN SalesLT.Customer t2 ON t1.CustomerID = t2.CustomerID ORDER BY t1.OrderDate DESC`
- 컬럼: SalesOrderNumber→SalesLT.SalesOrderHeader, OrderDate→SalesLT.SalesOrderHeader, CompanyName→SalesLT.Customer

### TC-08 ✅ JOIN
- 질문: 주문 상세 내역을 상품 이름과 같이 보여줘
- 실행 쿼리: `SELECT TOP 20 t1.SalesOrderID, t1.SalesOrderDetailID, t2.Name, t1.OrderQty, t1.UnitPrice, t1.LineTotal FROM SalesLT.SalesOrderDetail t1 JOIN SalesLT.Product t2 ON t1.ProductID = t2.ProductID ORDER BY t1.SalesOrderID DESC, t1.SalesOrderDetailID ASC`
- 컬럼: SalesOrderID→SalesLT.SalesOrderDetail, SalesOrderDetailID→SalesLT.SalesOrderDetail, Name→SalesLT.Product, OrderQty→SalesLT.SalesOrderDetail, UnitPrice→SalesLT.SalesOrderDetail, LineTotal→SalesLT.SalesOrderDetail

### TC-09 ✅ JOIN (3개 테이블)
- 질문: 고객 회사명과 주소의 도시 보여줘
- 실행 쿼리: `SELECT TOP 20 c.CompanyName, a.City FROM SalesLT.Customer c JOIN SalesLT.CustomerAddress ca ON c.CustomerID = ca.CustomerID JOIN SalesLT.Address a ON ca.AddressID = a.AddressID`
- 컬럼: CompanyName→SalesLT.Customer, City→SalesLT.Address

### TC-10 ✅ JOIN · 동명 컬럼
- 질문: 상품 이름과 상품 모델 이름 보여줘
- 실행 쿼리: `SELECT TOP 20 t1.Name AS ProductName, t2.Name AS ProductModelName FROM SalesLT.Product t1 LEFT JOIN SalesLT.ProductModel t2 ON t1.ProductModelID = t2.ProductModelID`
- 컬럼: ProductName→SalesLT.Product, ProductModelName→SalesLT.ProductModel

### TC-11 ✅ 집계
- 질문: 카테고리별 상품 수 알려줘
- 실행 쿼리: `SELECT t1.Name, COUNT(t2.ProductID) AS ProductCount FROM SalesLT.ProductCategory t1 LEFT JOIN SalesLT.Product t2 ON t1.ProductCategoryID = t2.ProductCategoryID GROUP BY t1.ProductCategoryID, t1.Name ORDER BY ProductCount DESC`
- 컬럼: Name→SalesLT.ProductCategory, ProductCount→미매칭

### TC-12 ✅ 집계 · JOIN
- 질문: 주문 총액이 가장 큰 고객 회사 5곳 보여줘
- 실행 쿼리: `SELECT TOP 5 t1.CompanyName, SUM(t2.TotalDue) AS TotalDue FROM SalesLT.Customer t1 JOIN SalesLT.SalesOrderHeader t2 ON t1.CustomerID = t2.CustomerID GROUP BY t1.CustomerID, t1.CompanyName ORDER BY SUM(t2.TotalDue) DESC`
- 컬럼: CompanyName→SalesLT.Customer, TotalDue→미매칭

### TC-13 ✅ 결과 0건
- 질문: 정가가 100만 이상인 상품 이름 보여줘
- 실행 쿼리: `SELECT Name, ListPrice FROM SalesLT.Product WHERE ListPrice >= 1000000 ORDER BY ListPrice DESC`
- 컬럼: Name→SalesLT.Product, ListPrice→SalesLT.Product
