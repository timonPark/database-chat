# mongodb 테스트케이스 — Atlas Sample Datasets (sample_data, 23개 컬렉션 — 케이스는 mflix_*)

> 이 파일은 `cases/mongodb.json` 에서 생성됩니다 (`node docs/test-cases/run-cases.mjs --db mongodb --list`). 직접 수정하지 말고 JSON 을 고친 뒤 다시 생성하세요.

- 샘플 데이터: npm run seed → MongoDB Atlas sampledata.archive 를 sample_data 한 DB 로 통합 적재 (컬렉션명 <원본DB>_<컬렉션>), DB_DATABASE=sample_data
- 테이블: `mflix_movies`, `mflix_comments`, `mflix_users`, `mflix_theaters`, `mflix_sessions`, `mflix_embedded_movies`
- 케이스에 쓰는 필드: mflix_movies(_id, title, year, runtime, rated, genres, cast, directors, imdb, …) · mflix_comments(_id, name, email, movie_id, text, date) · mflix_users(_id, name, email, password)
- 관계: mflix_comments.movie_id → mflix_movies._id · mflix_comments.email → mflix_users.email (이름 name · email 이 두 컬렉션에 같이 있음)
- 스키마 파일은 collections/<컬렉션>.md. 파일의 필드 목록에 _id 행이 있어야 _id 가 매칭된다
- mflix_users.password 는 서버가 결과에서 제외한다 (민감 필드)
- $lookup 결과는 $unwind 로 객체가 돼야 movie.title 처럼 펼쳐서 매칭된다 (배열 그대로면 해당 key 는 미매칭)
- $project · $group · $addFields 등 문서 형태를 바꾸는 stage 가 있으면 현재 설계상 columnConfidence 는 항상 partial (shape breaker). 단 $replaceRoot 로 lookup 컬렉션이 새 루트가 되면 다시 full

## 자연어 케이스 (`/chat`)

| ID | 구분 | 질문 | 예상 쿼리 | 기대 |
|---|---|---|---|---|
| TC-01 | 회귀 | 영화 목록 5개 보여줘 | — | `full` · 매칭 테이블 ⊂ {mflix_movies} |
| TC-02 | 회귀 · 필터 | 2015년에 개봉한 영화 제목과 상영시간 보여줘 | — | `full` · title→mflix_movies, runtime→mflix_movies · 매칭 테이블 ⊂ {mflix_movies} · partial 허용: LLM 이 $project 로 모양을 바꾸면 partial (현재 설계) |
| TC-03 | 회귀 · 민감 필드 | 사용자 목록 보여줘 | — | `full` · 매칭 테이블 ⊂ {mflix_users} · password 미노출 |
| TC-04 | $lookup | 최근 영화 댓글을 영화 제목과 같이 보여줘 | — | `full` · 매칭 테이블 ⊂ {mflix_comments, mflix_movies} · partial 허용: LLM 이 $project 로 모양을 바꾸면 partial (현재 설계) |
| TC-05 | $lookup · 동명 필드 | Ned Stark 가 댓글을 단 영화 제목과 댓글 내용 보여줘 | — | `full` · 매칭 테이블 ⊂ {mflix_comments, mflix_movies, mflix_users} · partial 허용: LLM 이 $project 로 모양을 바꾸면 partial (현재 설계) |
| TC-06 | 집계 | 관람 등급별 영화 수 알려줘 | — | `partial` · 매칭 테이블 ⊂ {mflix_movies} |
| TC-07 | 집계 · $lookup | 댓글을 가장 많이 단 사용자 5명 보여줘 | — | `partial` · 매칭 테이블 ⊂ {mflix_comments, mflix_users} |
| TC-08 | 결과 0건 | 3000년 이후에 개봉한 영화 보여줘 | — | `full` · 매칭 테이블 ⊂ {mflix_movies} · 0건 |

## 직접 쿼리 케이스 (API)

| ID | 구분 | 쿼리 | 기대 |
|---|---|---|---|
| D-01 | find · projection | `/db-query {"collection":"mflix_movies","filter":{"year":2015},"projection":{"_id":0,"title":1,"year":1,"runtime":1},"limit":5}` | `full` · 전 컬럼 source=mflix_movies |
| D-02 | find · 전체 필드 | `/db-query {"collection":"mflix_comments","filter":{},"limit":5}` | `full` · 전 컬럼 source=mflix_comments |
| D-03 | $lookup + $unwind | `/db-aggregate {"collection":"mflix_comments","pipeline":[{"$lookup":{"from":"mflix_movies","localField":"movie_id","foreignField":"_id","as":"movie"}},{"$unwind":"$movie"},{"$limit":5}]}` | `full` · text→mflix_comments, name→mflix_comments, movie.title→mflix_movies, movie.year→mflix_movies |
| D-04 | $lookup 2개 · 동명 필드 | `/db-aggregate {"collection":"mflix_comments","pipeline":[{"$lookup":{"from":"mflix_movies","localField":"movie_id","foreignField":"_id","as":"movie"}},{"$unwind":"$movie"},{"$lookup":{"from":"mflix_users","localField":"email","foreignField":"email","as":"user"}},{"$unwind":"$user"},{"$limit":5}]}` | `full` · name→mflix_comments, email→mflix_comments, user.name→mflix_users, user.email→mflix_users, movie.title→mflix_movies · user.password 미노출 |
| D-05 | $replaceRoot (lookup 컬렉션이 루트) | `/db-aggregate {"collection":"mflix_comments","pipeline":[{"$lookup":{"from":"mflix_movies","localField":"movie_id","foreignField":"_id","as":"movie"}},{"$unwind":"$movie"},{"$replaceRoot":{"newRoot":"$movie"}},{"$limit":5}]}` | `full` · 전 컬럼 source=mflix_movies |
| D-06 | $group $first → $replaceRoot (#181) | `/db-aggregate {"collection":"mflix_comments","pipeline":[{"$lookup":{"from":"mflix_users","localField":"email","foreignField":"email","as":"user"}},{"$unwind":"$user"},{"$group":{"_id":"$user._id","user":{"$first":"$user"}}},{"$replaceRoot":{"newRoot":"$user"}},{"$limit":5}]}` | `full` · 전 컬럼 source=mflix_users · password 미노출 |
| D-07 | $group 집계 | `/db-aggregate {"collection":"mflix_movies","pipeline":[{"$group":{"_id":"$rated","movieCount":{"$sum":1},"avgRuntime":{"$avg":"$runtime"}}},{"$limit":10}]}` | `partial` · 미매칭에 movieCount, avgRuntime 포함 |
| D-08 | $project (shape breaker) | `/db-aggregate {"collection":"mflix_movies","pipeline":[{"$project":{"_id":0,"title":1,"year":1}},{"$limit":5}]}` | `partial` · title→mflix_movies, year→mflix_movies · 미매칭 [] · 모든 key 가 매칭돼도 $project 가 있으면 partial — 현재 설계 (변경 시 이 케이스 갱신) |
| D-09 | $lookup 배열 그대로 | `/db-aggregate {"collection":"mflix_comments","pipeline":[{"$lookup":{"from":"mflix_movies","localField":"movie_id","foreignField":"_id","as":"movie"}},{"$limit":5}]}` | `partial` · text→mflix_comments · 미매칭 [movie] · $unwind 없이 배열이면 movie 는 미매칭 — 현재 설계 |
| D-10 | 결과 0건 헤더 | `/db-query {"collection":"mflix_movies","filter":{"year":{"$gt":3000}},"projection":{"title":1,"year":1},"limit":5}` | `full` · 전 컬럼 source=mflix_movies · 헤더 [title, year] · 0건 |
| D-11 | 민감 필드 | `/db-query {"collection":"mflix_users","filter":{},"limit":5}` | `full` · 전 컬럼 source=mflix_users · password 미노출 |
