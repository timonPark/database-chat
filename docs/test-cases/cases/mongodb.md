# mongodb 테스트케이스 — sample.json (users · products · orders)

> 이 파일은 `cases/mongodb.json` 에서 생성됩니다 (`node docs/test-cases/run-cases.mjs --db mongodb --list`). 직접 수정하지 말고 JSON 을 고친 뒤 다시 생성하세요.

- 샘플 데이터: npm run seed → seeds/mongodb/sample.json 을 DB_DATABASE (기본 mydb) 에 적재
- 테이블: `users`, `products`, `orders`
- 필드: users(id, name, email, age, city, joinedAt) · products(id, name, category, price, stock, rating) · orders(id, userId, productId, quantity, amount, status, orderedAt) + 각 문서의 _id
- 스키마 파일은 collections/<컬렉션>.md. 파일의 필드 목록에 _id 행이 있어야 _id 가 매칭된다
- $lookup 결과는 $unwind 로 객체가 돼야 user.name 처럼 펼쳐서 매칭된다 (배열 그대로면 해당 key 는 미매칭)
- $project · $group · $addFields 등 문서 형태를 바꾸는 stage 가 있으면 현재 설계상 columnConfidence 는 항상 partial (shape breaker). 단 $replaceRoot 로 lookup 컬렉션이 새 루트가 되면 다시 full

## 자연어 케이스 (`/chat`)

| ID | 구분 | 질문 | 예상 쿼리 | 기대 |
|---|---|---|---|---|
| TC-01 | 회귀 | 사용자 목록 보여줘 | — | `full` · 매칭 테이블 ⊂ {users} |
| TC-02 | 회귀 · 필터 | 서울에 사는 사용자 이름과 이메일 보여줘 | — | `full` · name→users, email→users · 매칭 테이블 ⊂ {users} |
| TC-03 | 회귀 · 정렬 | 가격이 비싼 상품 5개 보여줘 | — | `full` · price→products · 매칭 테이블 ⊂ {products} |
| TC-04 | $lookup | 주문 내역을 주문한 사용자 이름과 같이 보여줘 | — | `full` · 매칭 테이블 ⊂ {orders, users} · partial 허용: LLM 이 $project 로 모양을 바꾸면 partial (현재 설계) |
| TC-05 | $lookup · 동명 필드 | 주문별로 사용자 이름과 상품 이름을 같이 보여줘 | — | `full` · 매칭 테이블 ⊂ {orders, users, products} · partial 허용: LLM 이 $project 로 모양을 바꾸면 partial (현재 설계) |
| TC-06 | 집계 | 주문 상태별 주문 건수 알려줘 | — | `partial` · 매칭 테이블 ⊂ {orders} |
| TC-07 | 집계 · $lookup | 주문 금액 합계가 가장 큰 사용자 5명 보여줘 | — | `partial` · 매칭 테이블 ⊂ {orders, users} |
| TC-08 | 결과 0건 | 나이가 200살 이상인 사용자 보여줘 | — | `full` · 매칭 테이블 ⊂ {users} · 0건 |

## 직접 쿼리 케이스 (API)

| ID | 구분 | 쿼리 | 기대 |
|---|---|---|---|
| D-01 | find · projection | `/db-query {"collection":"users","filter":{"city":"서울"},"projection":{"_id":0,"name":1,"email":1,"city":1},"limit":5}` | `full` · 전 컬럼 source=users |
| D-02 | find · 전체 필드 | `/db-query {"collection":"orders","filter":{},"limit":5}` | `full` · 전 컬럼 source=orders |
| D-03 | $lookup + $unwind | `/db-aggregate {"collection":"orders","pipeline":[{"$lookup":{"from":"users","localField":"userId","foreignField":"id","as":"user"}},{"$unwind":"$user"},{"$limit":5}]}` | `full` · amount→orders, status→orders, user.name→users, user.email→users |
| D-04 | $lookup 2개 · 동명 필드 | `/db-aggregate {"collection":"orders","pipeline":[{"$lookup":{"from":"users","localField":"userId","foreignField":"id","as":"user"}},{"$unwind":"$user"},{"$lookup":{"from":"products","localField":"productId","foreignField":"id","as":"product"}},{"$unwind":"$product"},{"$limit":5}]}` | `full` · quantity→orders, user.name→users, product.name→products, product.price→products |
| D-05 | $replaceRoot (lookup 컬렉션이 루트) | `/db-aggregate {"collection":"orders","pipeline":[{"$match":{"status":"completed"}},{"$lookup":{"from":"products","localField":"productId","foreignField":"id","as":"product"}},{"$unwind":"$product"},{"$replaceRoot":{"newRoot":"$product"}},{"$limit":5}]}` | `full` · 전 컬럼 source=products |
| D-06 | $group $first → $replaceRoot (#181) | `/db-aggregate {"collection":"orders","pipeline":[{"$lookup":{"from":"users","localField":"userId","foreignField":"id","as":"user"}},{"$unwind":"$user"},{"$group":{"_id":"$user.id","user":{"$first":"$user"}}},{"$replaceRoot":{"newRoot":"$user"}},{"$limit":5}]}` | `full` · 전 컬럼 source=users |
| D-07 | $group 집계 | `/db-aggregate {"collection":"orders","pipeline":[{"$group":{"_id":"$status","totalAmount":{"$sum":"$amount"},"orderCount":{"$sum":1}}},{"$limit":10}]}` | `partial` · 미매칭에 totalAmount, orderCount 포함 |
| D-08 | $project (shape breaker) | `/db-aggregate {"collection":"users","pipeline":[{"$project":{"_id":0,"name":1,"city":1}},{"$limit":5}]}` | `partial` · name→users, city→users · 미매칭 [] · 모든 key 가 매칭돼도 $project 가 있으면 partial — 현재 설계 (변경 시 이 케이스 갱신) |
| D-09 | $lookup 배열 그대로 | `/db-aggregate {"collection":"orders","pipeline":[{"$lookup":{"from":"users","localField":"userId","foreignField":"id","as":"user"}},{"$limit":5}]}` | `partial` · amount→orders · 미매칭 [user] · $unwind 없이 배열이면 user 는 미매칭 — 현재 설계 |
| D-10 | 결과 0건 헤더 | `/db-query {"collection":"users","filter":{"age":{"$gt":200}},"projection":{"name":1,"age":1},"limit":5}` | `full` · 전 컬럼 source=users · 헤더 [name, age] · 0건 |
