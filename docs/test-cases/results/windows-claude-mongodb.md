# windows · claude · mongodb 테스트 결과

> 이슈: #195 · 검증표: #189

## 결론

| 항목 | 내용 |
|---|---|
| 실행일 · 실행자 | 2026-10-10 · Claude Code |
| 설치 폴더 · 모델 | `C:\database-chat\claude-mongodb` (`templates/windows/claude-mongodb` 와 server.ts · scripts · public · bat 동일) · `claude-haiku-4-5-20251001` |
| 샘플 데이터 | Atlas Sample Datasets (DB 서버 192.168.0.101 의 MongoDB, `sample_data`, 23개 컬렉션), `collections/*.md` 23/23 |
| 결과 | ✅ 19 · ⚠️ 0 · ❌ 0 |
| 최종 판정 | 통과 |

## REVIEW · FAIL 항목

없음.

## 실행기 보고서

`node docs/test-cases/run-cases.mjs --db mongodb --project claude-mongodb --out docs/test-cases/results/windows-claude-mongodb.md`

- 실행: 2026-10-10T14:28:59.919Z · OS: win32 · 서버: http://localhost:3111
- 설치 폴더: `C:\database-chat\claude-mongodb` · provider: claude · 모델: claude-haiku-4-5-20251001 · WITH 허용: ?
- 샘플 데이터: Atlas Sample Datasets (sample_data, 23개 컬렉션 — 케이스는 mflix_*)
- 결과: ✅ 19 · ⚠️ 0 · ❌ 0 (총 19)

| ID | 구분 | 결과 | confidence | 미매칭 | 비고 |
|---|---|---|---|---|---|
| D-01 | find · projection | ✅ | full |  |  |
| D-02 | find · 전체 필드 | ✅ | full |  |  |
| D-03 | $lookup + $unwind | ✅ | full |  |  |
| D-04 | $lookup 2개 · 동명 필드 | ✅ | full |  |  |
| D-05 | $replaceRoot (lookup 컬렉션이 루트) | ✅ | full |  |  |
| D-06 | $group $first → $replaceRoot (#181) | ✅ | full |  |  |
| D-07 | $group 집계 | ✅ | partial | movieCount, avgRuntime |  |
| D-08 | $project (shape breaker) | ✅ | partial |  |  |
| D-09 | $lookup 배열 그대로 | ✅ | partial | movie |  |
| D-10 | 결과 0건 헤더 | ✅ | full |  |  |
| D-11 | 민감 필드 | ✅ | full |  |  |
| TC-01 | 회귀 | ✅ | full |  |  |
| TC-02 | 회귀 · 필터 | ✅ | full |  |  |
| TC-03 | 회귀 · 민감 필드 | ✅ | full |  |  |
| TC-04 | $lookup | ✅ | partial | movie_title | partial 허용 — LLM 이 $project 로 모양을 바꾸면 partial (현재 설계) |
| TC-05 | $lookup · 동명 필드 | ✅ | partial | title | partial 허용 — LLM 이 $project 로 모양을 바꾸면 partial (현재 설계) |
| TC-06 | 집계 | ✅ | partial | count |  |
| TC-07 | 집계 · $lookup | ✅ | partial | commentCount |  |
| TC-08 | 결과 0건 | ✅ | full |  |  |

## 상세

### D-01 ✅ find · projection
- 실행 쿼리: `/db-query {"collection":"mflix_movies","filter":{"year":2015},"projection":{"_id":0,"title":1,"year":1,"runtime":1},"limit":5}`
- 컬럼: runtime→mflix_movies, title→mflix_movies, year→mflix_movies

### D-02 ✅ find · 전체 필드
- 실행 쿼리: `/db-query {"collection":"mflix_comments","filter":{},"limit":5}`
- 컬럼: _id→mflix_comments, name→mflix_comments, email→mflix_comments, movie_id→mflix_comments, text→mflix_comments, date→mflix_comments

### D-03 ✅ $lookup + $unwind
- 실행 쿼리: `/db-aggregate {"collection":"mflix_comments","pipeline":[{"$lookup":{"from":"mflix_movies","localField":"movie_id","foreignField":"_id","as":"movie"}},{"$unwind":"$movie"},{"$limit":5}]}`
- 컬럼: _id→mflix_comments, name→mflix_comments, email→mflix_comments, movie_id→mflix_comments, text→mflix_comments, date→mflix_comments, movie._id→mflix_movies, movie.plot→mflix_movies, movie.genres→mflix_movies, movie.runtime→mflix_movies, movie.cast→mflix_movies, movie.num_mflix_comments→mflix_movies, movie.title→mflix_movies, movie.fullplot→mflix_movies, movie.languages→mflix_movies, movie.released→mflix_movies, movie.directors→mflix_movies, movie.rated→mflix_movies, movie.awards→mflix_movies, movie.lastupdated→mflix_movies, movie.year→mflix_movies, movie.imdb→mflix_movies, movie.countries→mflix_movies, movie.type→mflix_movies, movie.tomatoes→mflix_movies, movie.poster→mflix_movies, movie.writers→mflix_movies

### D-04 ✅ $lookup 2개 · 동명 필드
- 실행 쿼리: `/db-aggregate {"collection":"mflix_comments","pipeline":[{"$lookup":{"from":"mflix_movies","localField":"movie_id","foreignField":"_id","as":"movie"}},{"$unwind":"$movie"},{"$lookup":{"from":"mflix_users","localField":"email","foreignField":"email","as":"user"}},{"$unwind":"$user"},{"$limit":5}]}`
- 컬럼: _id→mflix_comments, name→mflix_comments, email→mflix_comments, movie_id→mflix_comments, text→mflix_comments, date→mflix_comments, movie._id→mflix_movies, movie.plot→mflix_movies, movie.genres→mflix_movies, movie.runtime→mflix_movies, movie.cast→mflix_movies, movie.num_mflix_comments→mflix_movies, movie.title→mflix_movies, movie.fullplot→mflix_movies, movie.languages→mflix_movies, movie.released→mflix_movies, movie.directors→mflix_movies, movie.rated→mflix_movies, movie.awards→mflix_movies, movie.lastupdated→mflix_movies, movie.year→mflix_movies, movie.imdb→mflix_movies, movie.countries→mflix_movies, movie.type→mflix_movies, movie.tomatoes→mflix_movies, movie.poster→mflix_movies, movie.writers→mflix_movies, user._id→mflix_users, user.name→mflix_users, user.email→mflix_users

### D-05 ✅ $replaceRoot (lookup 컬렉션이 루트)
- 실행 쿼리: `/db-aggregate {"collection":"mflix_comments","pipeline":[{"$lookup":{"from":"mflix_movies","localField":"movie_id","foreignField":"_id","as":"movie"}},{"$unwind":"$movie"},{"$replaceRoot":{"newRoot":"$movie"}},{"$limit":5}]}`
- 컬럼: _id→mflix_movies, plot→mflix_movies, genres→mflix_movies, runtime→mflix_movies, cast→mflix_movies, num_mflix_comments→mflix_movies, title→mflix_movies, fullplot→mflix_movies, languages→mflix_movies, released→mflix_movies, directors→mflix_movies, rated→mflix_movies, awards→mflix_movies, lastupdated→mflix_movies, year→mflix_movies, imdb→mflix_movies, countries→mflix_movies, type→mflix_movies, tomatoes→mflix_movies, poster→mflix_movies, writers→mflix_movies

### D-06 ✅ $group $first → $replaceRoot (#181)
- 실행 쿼리: `/db-aggregate {"collection":"mflix_comments","pipeline":[{"$lookup":{"from":"mflix_users","localField":"email","foreignField":"email","as":"user"}},{"$unwind":"$user"},{"$group":{"_id":"$user._id","user":{"$first":"$user"}}},{"$replaceRoot":{"newRoot":"$user"}},{"$limit":5}]}`
- 컬럼: _id→mflix_users, name→mflix_users, email→mflix_users

### D-07 ✅ $group 집계
- 실행 쿼리: `/db-aggregate {"collection":"mflix_movies","pipeline":[{"$group":{"_id":"$rated","movieCount":{"$sum":1},"avgRuntime":{"$avg":"$runtime"}}},{"$limit":10}]}`
- 컬럼: _id→mflix_movies, movieCount→미매칭, avgRuntime→미매칭

### D-08 ✅ $project (shape breaker)
- 실행 쿼리: `/db-aggregate {"collection":"mflix_movies","pipeline":[{"$project":{"_id":0,"title":1,"year":1}},{"$limit":5}]}`
- 컬럼: title→mflix_movies, year→mflix_movies

### D-09 ✅ $lookup 배열 그대로
- 실행 쿼리: `/db-aggregate {"collection":"mflix_comments","pipeline":[{"$lookup":{"from":"mflix_movies","localField":"movie_id","foreignField":"_id","as":"movie"}},{"$limit":5}]}`
- 컬럼: _id→mflix_comments, name→mflix_comments, email→mflix_comments, movie_id→mflix_comments, text→mflix_comments, date→mflix_comments, movie→미매칭

### D-10 ✅ 결과 0건 헤더
- 실행 쿼리: `/db-query {"collection":"mflix_movies","filter":{"year":{"$gt":3000}},"projection":{"title":1,"year":1},"limit":5}`
- 컬럼: title→mflix_movies, year→mflix_movies

### D-11 ✅ 민감 필드
- 실행 쿼리: `/db-query {"collection":"mflix_users","filter":{},"limit":5}`
- 컬럼: _id→mflix_users, name→mflix_users, email→mflix_users

### TC-01 ✅ 회귀
- 질문: 영화 목록 5개 보여줘
- 실행 쿼리: `mflix_movies.find({}, {"title":1,"genres":1,"directors":1,"cast":1,"imdb":1})`
- 컬럼: _id→mflix_movies, genres→mflix_movies, cast→mflix_movies, title→mflix_movies, directors→mflix_movies, imdb→mflix_movies

### TC-02 ✅ 회귀 · 필터
- 질문: 2015년에 개봉한 영화 제목과 상영시간 보여줘
- 실행 쿼리: `mflix_movies.find({"year":2015}, {"title":1,"runtime":1,"_id":0})`
- 컬럼: runtime→mflix_movies, title→mflix_movies

### TC-03 ✅ 회귀 · 민감 필드
- 질문: 사용자 목록 보여줘
- 실행 쿼리: `mflix_users.find({}, {"_id":1,"name":1,"email":1})`
- 컬럼: _id→mflix_users, name→mflix_users, email→mflix_users

### TC-04 ✅ $lookup
- 질문: 최근 영화 댓글을 영화 제목과 같이 보여줘
- 실행 쿼리: `mflix_comments.aggregate([{"$sort":{"date":-1}},{"$lookup":{"from":"mflix_movies","localField":"movie_id","foreignField":"_id","as":"movie"}},{"$unwind":"$movie"},{"$project":{"text":1,"name":1,"date":1,"movie_title":"$movie.title"}},{"$limit":20}])`
- 컬럼: _id→mflix_comments, name→mflix_comments, text→mflix_comments, date→mflix_comments, movie_title→미매칭

### TC-05 ✅ $lookup · 동명 필드
- 질문: Ned Stark 가 댓글을 단 영화 제목과 댓글 내용 보여줘
- 실행 쿼리: `mflix_comments.aggregate([{"$match":{"name":"Ned Stark"}},{"$lookup":{"from":"mflix_movies","localField":"movie_id","foreignField":"_id","as":"movie"}},{"$unwind":"$movie"},{"$project":{"title":"$movie.title","text":1,"_id":0}},{"$limit":20}])`
- 컬럼: text→mflix_comments, title→미매칭

### TC-06 ✅ 집계
- 질문: 관람 등급별 영화 수 알려줘
- 실행 쿼리: `mflix_movies.aggregate([{"$group":{"_id":"$rated","count":{"$sum":1}}},{"$sort":{"count":-1}},{"$limit":20}])`
- 컬럼: _id→mflix_movies, count→미매칭

### TC-07 ✅ 집계 · $lookup
- 질문: 댓글을 가장 많이 단 사용자 5명 보여줘
- 실행 쿼리: `mflix_comments.aggregate([{"$group":{"_id":"$name","commentCount":{"$sum":1}}},{"$sort":{"commentCount":-1}},{"$limit":5}])`
- 컬럼: _id→mflix_comments, commentCount→미매칭

### TC-08 ✅ 결과 0건
- 질문: 3000년 이후에 개봉한 영화 보여줘
- 실행 쿼리: `mflix_movies.find({"year":{"$gte":3000}}, {"title":1,"year":1,"genres":1,"directors":1,"cast":1,"plot":1})`
- 컬럼: title→mflix_movies, year→mflix_movies, genres→mflix_movies, directors→mflix_movies, cast→mflix_movies, plot→mflix_movies
