# windows · claude · mssql 테스트 결과

> 이슈: #194 · 검증표: #189

## 결론

| 항목 | 내용 |
|---|---|
| 실행일 · 실행자 | 2026-11-10 · Claude Code |
| 설치 폴더 · 모델 | `C:\database-chat\claude-mssql` (`templates/windows/claude-mssql` 와 server.ts · start.bat · scripts · public 동일, main 8f6b7db + #194 의 server.ts 수정) · `claude-haiku-4-5-20251001` |
| 샘플 데이터 | README 1장 기준 — SQL Server 2022 (192.168.0.102:1433) · `AdventureWorksLT2022` (SalesLT 10 + dbo 2 tables), `tables/*.md` 12/12 |
| 결과 | ✅ 29 · ⚠️ 0 · ❌ 0 |
| 최종 판정 | 통과 |

## REVIEW · FAIL 항목

없음.

- MSSQL 필수 케이스: `FROM SalesLT.t` (D-01) · `[SalesLT].[t]` (D-02) · `dbo.t` (D-03) · 접두사 없는 `FROM t` (D-04) · 3-part 이름 (D-06) · `WITH (NOLOCK)` (D-08) · `별칭 = 컬럼` (D-09) · CTE (D-13) 모두 PASS
- 민감 컬럼: D-14 · TC-03 모두 `PasswordHash` · `PasswordSalt` 미노출

## 경과

- 1차 실행 (main 8f6b7db, 27건): 실행기는 ✅ 27 이었지만 사람이 재판정해 ❌ 1 (TC-10) — 별칭 없는 동명 컬럼 (`p.Name, pc.Name`) 을 `mssql` 드라이버가 key 하나 (`Name`) 에 값 배열 `[상품명, 카테고리명]` 으로 합쳐 돌려주고, 서버는 이를 `Name→SalesLT.Product` · `full` 로 판정 (두 번째 테이블 값이 별도 컬럼으로 안 나오고 라벨도 틀림). 실행기는 `Name→SalesLT.Product` 만 보고 PASS 처리
- #194 에서 `server.ts` 가 `arrayRowMode` 로 결과를 받아 두 번째부터 `<이름>_1` · `<이름>_2` … 로 key 를 나누도록 수정 (Oracle #223 과 같은 규칙 — 매칭은 기존 `build-columns.ts` 의 `resolveDuplicate`). `/db-query` · `/chat` · `/db-export` 모두 적용. 케이스 D-15 · D-16 추가 (수정 전 서버에서 ❌ 재현 확인)
- 2차 실행 (29건): 3종 모두 통과, TC-05 · TC-10 은 `Name→SalesLT.Product` · `Name_1→SalesLT.ProductCategory` (TC-10 은 `SalesLT.ProductModel`)

## 실행기 보고서

`node docs/test-cases/run-cases.mjs --db mssql --project claude-mssql --out docs/test-cases/results/windows-claude-mssql.md`

> 3종 모두 `PORT=3111` 이라 `start.bat` 로 하나씩 띄워 순서대로 실행

- 실행: 2026-11-09T15:56:09.756Z · OS: win32 · 서버: http://localhost:3111
- 설치 폴더: `C:\database-chat\claude-mssql` · provider: claude · 모델: claude-haiku-4-5-20251001 · WITH 허용: true
- 샘플 데이터: AdventureWorksLT2022
- 결과: ✅ 29 · ⚠️ 0 · ❌ 0 (총 29)

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
| D-15 | 동명 컬럼 중복 (다른 테이블) | ✅ | full |  |  |
| D-16 | 동명 컬럼 중복 (셀프 조인) | ✅ | full |  |  |
| TC-01 | 회귀 | ✅ | full |  |  |
| TC-02 | 회귀 | ✅ | full |  |  |
| TC-03 | 회귀 · 민감 컬럼 | ✅ | full |  |  |
| TC-04 | 회귀 · 서브쿼리 | ✅ | full |  |  |
| TC-05 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| TC-06 | JOIN (상대 컬럼만) | ✅ | full |  |  |
| TC-07 | JOIN | ✅ | full |  |  |
| TC-08 | JOIN | ✅ | full |  |  |
| TC-09 | JOIN (3개 테이블) | ✅ | full |  |  |
| TC-10 | JOIN · 동명 컬럼 | ✅ | full |  |  |
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

### D-14 ✅ 민감 컬럼
- 실행 쿼리: `SELECT TOP 5 * FROM SalesLT.Customer`
- 컬럼: CustomerID→SalesLT.Customer, NameStyle→SalesLT.Customer, Title→SalesLT.Customer, FirstName→SalesLT.Customer, MiddleName→SalesLT.Customer, LastName→SalesLT.Customer, Suffix→SalesLT.Customer, CompanyName→SalesLT.Customer, SalesPerson→SalesLT.Customer, EmailAddress→SalesLT.Customer, Phone→SalesLT.Customer, rowguid→SalesLT.Customer, ModifiedDate→SalesLT.Customer

### D-15 ✅ 동명 컬럼 중복 (다른 테이블)
- 실행 쿼리: `SELECT TOP 5 p.Name, c.Name FROM SalesLT.Product p JOIN SalesLT.ProductCategory c ON c.ProductCategoryID = p.ProductCategoryID`
- 컬럼: Name→SalesLT.Product, Name_1→SalesLT.ProductCategory

### D-16 ✅ 동명 컬럼 중복 (셀프 조인)
- 실행 쿼리: `SELECT TOP 5 c.Name, pc.Name FROM SalesLT.ProductCategory c JOIN SalesLT.ProductCategory pc ON pc.ProductCategoryID = c.ParentProductCategoryID`
- 컬럼: Name→SalesLT.ProductCategory, Name_1→SalesLT.ProductCategory

### TC-01 ✅ 회귀
- 질문: 상품 목록 5개 보여줘
- 실행 쿼리: `SELECT TOP 5 ProductID, Name, ProductNumber, Color, StandardCost, ListPrice, Size, Weight FROM SalesLT.Product ORDER BY ProductID`
- 컬럼: ProductID→SalesLT.Product, Name→SalesLT.Product, ProductNumber→SalesLT.Product, Color→SalesLT.Product, StandardCost→SalesLT.Product, ListPrice→SalesLT.Product, Size→SalesLT.Product, Weight→SalesLT.Product

### TC-02 ✅ 회귀
- 질문: 정가가 가장 비싼 상품 10개의 이름과 가격 보여줘
- 실행 쿼리: `SELECT TOP 10 Name, ListPrice FROM SalesLT.Product ORDER BY ListPrice DESC`
- 컬럼: Name→SalesLT.Product, ListPrice→SalesLT.Product

### TC-03 ✅ 회귀 · 민감 컬럼
- 질문: 고객 정보 전부 보여줘
- 실행 쿼리: `SELECT TOP 20 CustomerID, FirstName, LastName, CompanyName, SalesPerson, EmailAddress, Phone FROM SalesLT.Customer ORDER BY CustomerID`
- 컬럼: CustomerID→SalesLT.Customer, FirstName→SalesLT.Customer, LastName→SalesLT.Customer, CompanyName→SalesLT.Customer, SalesPerson→SalesLT.Customer, EmailAddress→SalesLT.Customer, Phone→SalesLT.Customer

### TC-04 ✅ 회귀 · 서브쿼리
- 질문: 한 번도 주문되지 않은 상품 알려줘
- 실행 쿼리: `SELECT TOP 20 p.ProductID, p.Name, p.ProductNumber, p.Color, p.ListPrice FROM SalesLT.Product p LEFT JOIN SalesLT.SalesOrderDetail d ON p.ProductID = d.ProductID WHERE d.SalesOrderDetailID IS NULL ORDER BY p.ProductID`
- 컬럼: ProductID→SalesLT.Product, Name→SalesLT.Product, ProductNumber→SalesLT.Product, Color→SalesLT.Product, ListPrice→SalesLT.Product

### TC-05 ✅ JOIN · 동명 컬럼
- 질문: 상품 이름과 카테고리 이름 보여줘
- 실행 쿼리: `SELECT TOP 20 p.Name, pc.Name FROM SalesLT.Product p JOIN SalesLT.ProductCategory pc ON p.ProductCategoryID = pc.ProductCategoryID ORDER BY p.Name`
- 컬럼: Name→SalesLT.Product, Name_1→SalesLT.ProductCategory

### TC-06 ✅ JOIN (상대 컬럼만)
- 질문: Road Bikes 카테고리에 속한 상품 이름과 가격 알려줘
- 실행 쿼리: `SELECT TOP 100 p.Name, p.ListPrice FROM SalesLT.Product p JOIN SalesLT.ProductCategory pc ON p.ProductCategoryID = pc.ProductCategoryID WHERE pc.Name = 'Road Bikes' ORDER BY p.Name`
- 컬럼: Name→SalesLT.Product, ListPrice→SalesLT.Product

### TC-07 ✅ JOIN
- 질문: 주문 번호, 주문일, 고객 회사명 보여줘
- 실행 쿼리: `SELECT TOP 20 soh.SalesOrderNumber, soh.OrderDate, c.CompanyName FROM SalesLT.SalesOrderHeader soh JOIN SalesLT.Customer c ON soh.CustomerID = c.CustomerID ORDER BY soh.OrderDate DESC`
- 컬럼: SalesOrderNumber→SalesLT.SalesOrderHeader, OrderDate→SalesLT.SalesOrderHeader, CompanyName→SalesLT.Customer

### TC-08 ✅ JOIN
- 질문: 주문 상세 내역을 상품 이름과 같이 보여줘
- 실행 쿼리: `SELECT TOP 20 t1.SalesOrderID, t1.SalesOrderDetailID, t2.Name, t1.OrderQty, t1.UnitPrice, t1.UnitPriceDiscount, t1.LineTotal FROM SalesLT.SalesOrderDetail t1 JOIN SalesLT.Product t2 ON t1.ProductID = t2.ProductID ORDER BY t1.SalesOrderID DESC`
- 컬럼: SalesOrderID→SalesLT.SalesOrderDetail, SalesOrderDetailID→SalesLT.SalesOrderDetail, Name→SalesLT.Product, OrderQty→SalesLT.SalesOrderDetail, UnitPrice→SalesLT.SalesOrderDetail, UnitPriceDiscount→SalesLT.SalesOrderDetail, LineTotal→SalesLT.SalesOrderDetail

### TC-09 ✅ JOIN (3개 테이블)
- 질문: 고객 회사명과 주소의 도시 보여줘
- 실행 쿼리: `SELECT TOP 20 c.CompanyName, a.City FROM SalesLT.Customer c JOIN SalesLT.CustomerAddress ca ON c.CustomerID = ca.CustomerID JOIN SalesLT.Address a ON ca.AddressID = a.AddressID ORDER BY c.CompanyName, a.City`
- 컬럼: CompanyName→SalesLT.Customer, City→SalesLT.Address

### TC-10 ✅ JOIN · 동명 컬럼
- 질문: 상품 이름과 상품 모델 이름 보여줘
- 실행 쿼리: `SELECT TOP 20 p.Name, pm.Name FROM SalesLT.Product p JOIN SalesLT.ProductModel pm ON p.ProductModelID = pm.ProductModelID ORDER BY p.ProductID`
- 컬럼: Name→SalesLT.Product, Name_1→SalesLT.ProductModel

### TC-11 ✅ 집계
- 질문: 카테고리별 상품 수 알려줘
- 실행 쿼리: `SELECT TOP 100 c.ProductCategoryID, c.Name, COUNT(p.ProductID) AS ProductCount FROM SalesLT.ProductCategory c LEFT JOIN SalesLT.Product p ON c.ProductCategoryID = p.ProductCategoryID GROUP BY c.ProductCategoryID, c.Name ORDER BY ProductCount DESC`
- 컬럼: ProductCategoryID→SalesLT.ProductCategory, Name→SalesLT.ProductCategory, ProductCount→미매칭

### TC-12 ✅ 집계 · JOIN
- 질문: 주문 총액이 가장 큰 고객 회사 5곳 보여줘
- 실행 쿼리: `SELECT TOP 5 c.CompanyName, SUM(h.TotalDue) AS TotalDue FROM SalesLT.Customer c JOIN SalesLT.SalesOrderHeader h ON c.CustomerID = h.CustomerID GROUP BY c.CompanyName ORDER BY SUM(h.TotalDue) DESC`
- 컬럼: CompanyName→SalesLT.Customer, TotalDue→미매칭

### TC-13 ✅ 결과 0건
- 질문: 정가가 100만 이상인 상품 이름 보여줘
- 실행 쿼리: `SELECT TOP 20 Name FROM SalesLT.Product WHERE ListPrice >= 1000000 ORDER BY ListPrice DESC`
- 컬럼: Name→SalesLT.Product
