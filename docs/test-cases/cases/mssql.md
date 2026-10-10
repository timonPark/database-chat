# mssql 테스트케이스 — AdventureWorksLT2022

> 이 파일은 `cases/mssql.json` 에서 생성됩니다 (`node docs/test-cases/run-cases.mjs --db mssql --list`). 직접 수정하지 말고 JSON 을 고친 뒤 다시 생성하세요.

- 샘플 데이터: npm run seed → microsoft/sql-server-samples AdventureWorksLT2022.bak 복원, DB_DATABASE=AdventureWorksLT2022
- 테이블: `SalesLT.Address`, `SalesLT.Customer`, `SalesLT.CustomerAddress`, `SalesLT.Product`, `SalesLT.ProductCategory`, `SalesLT.ProductDescription`, `SalesLT.ProductModel`, `SalesLT.ProductModelProductDescription`, `SalesLT.SalesOrderDetail`, `SalesLT.SalesOrderHeader`, `dbo.BuildVersion`, `dbo.ErrorLog`
- 업무 테이블은 SalesLT 스키마, dbo 에는 BuildVersion · ErrorLog 만 있다. 스키마 파일 이름은 <schema>.<table>.md (예: tables/SalesLT.Product.md) — source 도 같은 이름
- SalesLT 테이블은 기본 스키마(dbo)가 아니므로 접두사 없이 FROM Product 로는 DB 에서 실행되지 않는다. 접두사 생략 케이스는 dbo.BuildVersion 으로 확인
- SalesLT.Customer 에는 PasswordHash · PasswordSalt 컬럼이 있다 — 결과에 노출되면 안 됨

## 자연어 케이스 (`/chat`)

| ID | 구분 | 질문 | 예상 쿼리 | 기대 |
|---|---|---|---|---|
| TC-01 | 회귀 | 상품 목록 5개 보여줘 | `SELECT TOP 5 * FROM SalesLT.Product` | `full` · 매칭 테이블 ⊂ {SalesLT.Product} |
| TC-02 | 회귀 | 정가가 가장 비싼 상품 10개의 이름과 가격 보여줘 | `SELECT TOP 10 Name, ListPrice FROM SalesLT.Product ORDER BY ListPrice DESC` | `full` · Name→SalesLT.Product, ListPrice→SalesLT.Product · 매칭 테이블 ⊂ {SalesLT.Product} |
| TC-03 | 회귀 · 민감 컬럼 | 고객 정보 전부 보여줘 | `SELECT TOP 20 * FROM SalesLT.Customer` | `full` · 매칭 테이블 ⊂ {SalesLT.Customer} · PasswordHash, PasswordSalt 미노출 |
| TC-04 | 회귀 · 서브쿼리 | 한 번도 주문되지 않은 상품 알려줘 | `SELECT ProductID, Name FROM SalesLT.Product WHERE ProductID NOT IN (SELECT ProductID FROM SalesLT.SalesOrderDetail)` | `full` · Name→SalesLT.Product · 매칭 테이블 ⊂ {SalesLT.Product, SalesLT.SalesOrderDetail} |
| TC-05 | JOIN · 동명 컬럼 | 상품 이름과 카테고리 이름 보여줘 | `SELECT p.Name, c.Name AS CategoryName FROM SalesLT.Product p JOIN SalesLT.ProductCategory c ON c.ProductCategoryID = p.ProductCategoryID` | `full` · Name→SalesLT.Product · 매칭 테이블 ⊂ {SalesLT.Product, SalesLT.ProductCategory} |
| TC-06 | JOIN (상대 컬럼만) | Road Bikes 카테고리에 속한 상품 이름과 가격 알려줘 | `SELECT p.Name, p.ListPrice FROM SalesLT.ProductCategory c JOIN SalesLT.Product p ON p.ProductCategoryID = c.ProductCategoryID WHERE c.Name = 'Road Bikes'` | `full` · Name→SalesLT.Product, ListPrice→SalesLT.Product · 매칭 테이블 ⊂ {SalesLT.Product, SalesLT.ProductCategory} |
| TC-07 | JOIN | 주문 번호, 주문일, 고객 회사명 보여줘 | `SELECT h.SalesOrderNumber, h.OrderDate, c.CompanyName FROM SalesLT.SalesOrderHeader h JOIN SalesLT.Customer c ON c.CustomerID = h.CustomerID` | `full` · SalesOrderNumber→SalesLT.SalesOrderHeader, CompanyName→SalesLT.Customer · 매칭 테이블 ⊂ {SalesLT.SalesOrderHeader, SalesLT.Customer} |
| TC-08 | JOIN | 주문 상세 내역을 상품 이름과 같이 보여줘 | `SELECT d.SalesOrderID, p.Name, d.OrderQty, d.UnitPrice, d.LineTotal FROM SalesLT.SalesOrderDetail d JOIN SalesLT.Product p ON p.ProductID = d.ProductID` | `full` · Name→SalesLT.Product, OrderQty→SalesLT.SalesOrderDetail · 매칭 테이블 ⊂ {SalesLT.SalesOrderDetail, SalesLT.Product} |
| TC-09 | JOIN (3개 테이블) | 고객 회사명과 주소의 도시 보여줘 | `SELECT c.CompanyName, a.City, a.StateProvince FROM SalesLT.Customer c JOIN SalesLT.CustomerAddress ca ON ca.CustomerID = c.CustomerID JOIN SalesLT.Address a ON a.AddressID = ca.AddressID` | `full` · CompanyName→SalesLT.Customer, City→SalesLT.Address · 매칭 테이블 ⊂ {SalesLT.Customer, SalesLT.CustomerAddress, SalesLT.Address} |
| TC-10 | JOIN · 동명 컬럼 | 상품 이름과 상품 모델 이름 보여줘 | `SELECT p.Name, m.Name AS ModelName FROM SalesLT.Product p JOIN SalesLT.ProductModel m ON m.ProductModelID = p.ProductModelID` | `full` · Name→SalesLT.Product · 매칭 테이블 ⊂ {SalesLT.Product, SalesLT.ProductModel} |
| TC-11 | 집계 | 카테고리별 상품 수 알려줘 | `SELECT c.Name, COUNT(*) AS ProductCount FROM SalesLT.Product p JOIN SalesLT.ProductCategory c ON c.ProductCategoryID = p.ProductCategoryID GROUP BY c.Name` | `partial` · 매칭 테이블 ⊂ {SalesLT.Product, SalesLT.ProductCategory} |
| TC-12 | 집계 · JOIN | 주문 총액이 가장 큰 고객 회사 5곳 보여줘 | `SELECT TOP 5 c.CompanyName, SUM(h.TotalDue) AS TotalAmount FROM SalesLT.SalesOrderHeader h JOIN SalesLT.Customer c ON c.CustomerID = h.CustomerID GROUP BY c.CompanyName ORDER BY TotalAmount DESC` | `partial` · CompanyName→SalesLT.Customer · 매칭 테이블 ⊂ {SalesLT.Customer, SalesLT.SalesOrderHeader} |
| TC-13 | 결과 0건 | 정가가 100만 이상인 상품 이름 보여줘 | `SELECT Name FROM SalesLT.Product WHERE ListPrice >= 1000000` | `full` · 매칭 테이블 ⊂ {SalesLT.Product} · 0건 |

## 직접 쿼리 케이스 (API)

| ID | 구분 | 쿼리 | 기대 |
|---|---|---|---|
| D-01 | 스키마 접두사 | `SELECT TOP 5 * FROM SalesLT.Product` | `full` · 전 컬럼 source=SalesLT.Product |
| D-02 | 대괄호 식별자 | `SELECT TOP 5 * FROM [SalesLT].[Product]` | `full` · 전 컬럼 source=SalesLT.Product |
| D-03 | dbo 접두사 | `SELECT * FROM dbo.BuildVersion` | `full` · 전 컬럼 source=dbo.BuildVersion |
| D-04 | 접두사 생략 (기본 스키마 dbo) | `SELECT * FROM BuildVersion` | `full` · 전 컬럼 source=dbo.BuildVersion |
| D-05 | 공백 포함 컬럼 | `SELECT [Database Version], VersionDate FROM dbo.BuildVersion` | `full` · 전 컬럼 source=dbo.BuildVersion |
| D-06 | 3-part 이름 | `SELECT TOP 5 ProductID, Name FROM AdventureWorksLT2022.SalesLT.Product` | `full` · 전 컬럼 source=SalesLT.Product |
| D-07 | JOIN · 동명 컬럼 (별칭) | `SELECT TOP 5 p.Name, c.Name AS CategoryName FROM SalesLT.Product p JOIN SalesLT.ProductCategory c ON c.ProductCategoryID = p.ProductCategoryID` | `full` · Name→SalesLT.Product, CategoryName→SalesLT.ProductCategory |
| D-08 | JOIN alias.* · NOLOCK | `SELECT TOP 5 c.* FROM SalesLT.Product p WITH (NOLOCK) JOIN SalesLT.ProductCategory c ON c.ProductCategoryID = p.ProductCategoryID` | `full` · 전 컬럼 source=SalesLT.ProductCategory |
| D-09 | MSSQL 별칭 = 컬럼 · 소문자 참조 | `SELECT TOP 5 Product = p.name, price = p.listprice FROM SalesLT.Product p` | `full` · Product→SalesLT.Product, price→SalesLT.Product |
| D-10 | 콤마 조인 | `SELECT TOP 5 h.SalesOrderNumber, c.CompanyName FROM SalesLT.SalesOrderHeader h, SalesLT.Customer c WHERE c.CustomerID = h.CustomerID` | `full` · SalesOrderNumber→SalesLT.SalesOrderHeader, CompanyName→SalesLT.Customer |
| D-11 | 집계 | `SELECT Color, COUNT(*) AS ProductCount FROM SalesLT.Product GROUP BY Color` | `partial` · Color→SalesLT.Product · 미매칭 [ProductCount] |
| D-12 | 결과 0건 헤더 | `SELECT Name, ListPrice FROM SalesLT.Product WHERE 1 = 0` | `full` · 전 컬럼 source=SalesLT.Product · 헤더 [Name, ListPrice] · 0건 |
| D-13 | CTE | `WITH cat AS (SELECT ProductCategoryID, Name FROM SalesLT.ProductCategory) SELECT TOP 5 p.Name, p.ListPrice FROM SalesLT.Product p JOIN cat ON cat.ProductCategoryID = p.ProductCategoryID` | `full` · 전 컬럼 source=SalesLT.Product · WITH 미허용 템플릿은 400 거부가 기대 결과 |
| D-14 | 민감 컬럼 | `SELECT TOP 5 * FROM SalesLT.Customer` | `full` · 전 컬럼 source=SalesLT.Customer · PasswordHash, PasswordSalt 미노출 |
