# windows · codex · mysql 테스트 결과

> 이슈: #191 · 검증표: #189

## 결론

| 항목 | 내용 |
|---|---|
| 실행일 · 실행자 | 2026-10-10 · Claude Code |
| 설치 폴더 · 모델 | `C:\database-chat\codex-mysql` (`templates/windows/codex-mysql` 과 매칭 스크립트 · server.ts 동일) · `gpt-5.6-luna` |
| 샘플 데이터 | sakila (README 1장 기준, DB 서버 192.168.0.101 의 MySQL) |
| 결과 | ✅ 25 · ⚠️ 1 · ❌ 0 |
| 최종 판정 | 통과 |

- 1차 실행에서 TC-08 이 ❌ — Codex CLI 가 OpenAI 서버에 재연결 5회 실패 (`Reconnecting... 5/5`, 와이파이 변경 직후 네트워크 오류). 원인 분류 **환경**. 같은 질문으로 재실행해 ✅ (보고서에 재실행 결과 반영)

## REVIEW · FAIL 항목

| ID | 등급 | 원인 분류 | 판단 · 조치 |
|---|---|---|---|
| TC-10 | ⚠️ | LLM 쿼리 (CONCAT 계산 컬럼) | 정상 — `CONCAT(st.first_name, ' ', st.last_name) AS manager_name` 은 계산 컬럼이라 미매칭. 같은 쿼리의 `store_id`→store, `address`→address 는 올바르게 매칭 |

## 실행기 보고서

`node docs/test-cases/run-cases.mjs --db mysql --url http://localhost:<port> --project codex-mysql --out ...`


- 실행: 2026-10-10T11:38:09.109Z · OS: win32 · 서버: http://localhost:3122
- 설치 폴더: `C:\database-chat\codex-mysql` · provider: codex · 모델: gpt-5.6-luna · WITH 허용: true
- 샘플 데이터: sakila
- 결과: ✅ 25 · ⚠️ 1 · ❌ 0 (총 26) — 재실행 1건 반영

| ID | 구분 | 결과 | confidence | 미매칭 | 비고 |
|---|---|---|---|---|---|
| D-01 | 따옴표 식별자 | ✅ | full |  |  |
| D-02 | DB 접두사 | ✅ | full |  |  |
| D-03 | JOIN alias.* | ✅ | full |  |  |
| D-04 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| D-05 | 컬럼 별칭 | ✅ | full |  |  |
| D-06 | 콤마 조인 | ✅ | full |  |  |
| D-07 | 문자열 안 키워드 | ✅ | full |  |  |
| D-08 | FROM 서브쿼리 | ✅ | full |  |  |
| D-09 | 집계 | ✅ | partial | film_count |  |
| D-10 | 결과 0건 헤더 | ✅ | full |  |  |
| D-11 | CTE | ✅ | full |  |  |
| D-12 | 민감 컬럼 | ✅ | full |  |  |
| TC-01 | 회귀 | ✅ | full |  |  |
| TC-02 | 회귀 | ✅ | full |  |  |
| TC-03 | 회귀 · 민감 컬럼 | ✅ | full |  |  |
| TC-04 | 회귀 · 서브쿼리 | ✅ | full |  |  |
| TC-05 | JOIN | ✅ | full |  |  |
| TC-06 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| TC-07 | JOIN | ✅ | full |  |  |
| TC-08 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| TC-09 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| TC-10 | JOIN · 동명 컬럼 | ⚠️ | partial | manager_name | staff 로 매칭된 컬럼 없음 — LLM 이 해당 테이블 컬럼을 조회하지 않았거나 계산 컬럼으로 바꿨는지 확인 / partial · 미매칭 [manager_name] — CONCAT · 집계 같은 계산 컬럼이면 정상, 스키마 컬럼이면 버그 / first_name 컬럼 없음 (별칭 · 생략) |
| TC-11 | JOIN | ✅ | full |  |  |
| TC-12 | 집계 | ✅ | partial | film_count |  |
| TC-13 | 집계 · JOIN | ✅ | partial | total_amount |  |
| TC-14 | 결과 0건 | ✅ | full |  |  |

### 상세

#### D-01 ✅ 따옴표 식별자
- 실행 쿼리: `SELECT * FROM `film` LIMIT 5`
- 컬럼: film_id→film, title→film, description→film, release_year→film, language_id→film, original_language_id→film, rental_duration→film, rental_rate→film, length→film, replacement_cost→film, rating→film, special_features→film, last_update→film

#### D-02 ✅ DB 접두사
- 실행 쿼리: `SELECT * FROM sakila.film LIMIT 5`
- 컬럼: film_id→film, title→film, description→film, release_year→film, language_id→film, original_language_id→film, rental_duration→film, rental_rate→film, length→film, replacement_cost→film, rating→film, special_features→film, last_update→film

#### D-03 ✅ JOIN alias.*
- 실행 쿼리: `SELECT a.* FROM film f JOIN film_actor fa ON fa.film_id = f.film_id JOIN actor a ON a.actor_id = fa.actor_id LIMIT 5`
- 컬럼: actor_id→actor, first_name→actor, last_name→actor, last_update→actor

#### D-04 ✅ JOIN · 동명 컬럼
- 실행 쿼리: `SELECT s.store_id, st.first_name, st.last_name, ad.address FROM store s JOIN staff st ON st.staff_id = s.manager_staff_id JOIN address ad ON ad.address_id = s.address_id`
- 컬럼: store_id→store, first_name→staff, last_name→staff, address→address

#### D-05 ✅ 컬럼 별칭
- 실행 쿼리: `SELECT c.first_name AS customer_name, c.email AS mail FROM customer c LIMIT 5`
- 컬럼: customer_name→customer, mail→customer

#### D-06 ✅ 콤마 조인
- 실행 쿼리: `SELECT f.title, l.name FROM film f, language l WHERE l.language_id = f.language_id LIMIT 5`
- 컬럼: title→film, name→language

#### D-07 ✅ 문자열 안 키워드
- 실행 쿼리: `SELECT title FROM film WHERE description LIKE '%JOIN actor FROM%' LIMIT 5`
- 컬럼: title→film

#### D-08 ✅ FROM 서브쿼리
- 실행 쿼리: `SELECT * FROM (SELECT title, rating FROM film ORDER BY length DESC LIMIT 5) AS t`
- 컬럼: title→film, rating→film

#### D-09 ✅ 집계
- 실행 쿼리: `SELECT rating, COUNT(*) AS film_count FROM film GROUP BY rating`
- 컬럼: rating→film, film_count→미매칭

#### D-10 ✅ 결과 0건 헤더
- 실행 쿼리: `SELECT title, release_year FROM film WHERE 1 = 0`
- 컬럼: title→film, release_year→film

#### D-11 ✅ CTE
- 실행 쿼리: `WITH r AS (SELECT customer_id FROM rental) SELECT * FROM customer WHERE customer_id IN (SELECT customer_id FROM r) LIMIT 5`
- 컬럼: customer_id→customer, store_id→customer, first_name→customer, last_name→customer, email→customer, address_id→customer, active→customer, create_date→customer, last_update→customer

#### D-12 ✅ 민감 컬럼
- 실행 쿼리: `SELECT * FROM staff`
- 컬럼: staff_id→staff, first_name→staff, last_name→staff, address_id→staff, picture→staff, email→staff, store_id→staff, active→staff, username→staff, last_update→staff

#### TC-01 ✅ 회귀
- 질문: 영화 목록 5개 보여줘
- 실행 쿼리: `SELECT film_id, title, description, release_year, rental_duration, rental_rate, length, rating FROM film ORDER BY film_id LIMIT 20`
- 컬럼: film_id→film, title→film, description→film, release_year→film, rental_duration→film, rental_rate→film, length→film, rating→film

#### TC-02 ✅ 회귀
- 질문: R 등급 영화 중 상영시간이 긴 순서로 제목이랑 상영시간 보여줘
- 실행 쿼리: `SELECT title, length FROM film WHERE rating = 'R' ORDER BY length DESC LIMIT 20`
- 컬럼: title→film, length→film

#### TC-03 ✅ 회귀 · 민감 컬럼
- 질문: 직원 정보 전부 보여줘
- 실행 쿼리: `SELECT staff_id, first_name, last_name, address_id, store_id, active, username FROM staff ORDER BY staff_id LIMIT 20`
- 컬럼: staff_id→staff, first_name→staff, last_name→staff, address_id→staff, store_id→staff, active→staff, username→staff

#### TC-04 ✅ 회귀 · 서브쿼리
- 질문: 재고가 하나도 없는 영화 알려줘
- 실행 쿼리: `SELECT t1.film_id, t1.title FROM film AS t1 LEFT JOIN inventory AS t2 ON t1.film_id = t2.film_id WHERE t2.inventory_id IS NULL ORDER BY t1.title LIMIT 20`
- 컬럼: film_id→film, title→film

#### TC-05 ✅ JOIN
- 질문: 배우 PENELOPE GUINESS 가 출연한 영화 제목 알려줘
- 실행 쿼리: `SELECT t1.title FROM film AS t1 JOIN film_actor AS t2 ON t1.film_id = t2.film_id JOIN actor AS t3 ON t2.actor_id = t3.actor_id WHERE t3.first_name = 'PENELOPE' AND t3.last_name = 'GUINESS' ORDER BY t1.title LIMIT 20`
- 컬럼: title→film

#### TC-06 ✅ JOIN · 동명 컬럼
- 질문: ACADEMY DINOSAUR 영화에 출연한 배우 이름 알려줘
- 실행 쿼리: `SELECT a.first_name, a.last_name FROM film f JOIN film_actor fa ON f.film_id = fa.film_id JOIN actor a ON fa.actor_id = a.actor_id WHERE f.title = 'ACADEMY DINOSAUR' ORDER BY a.last_name, a.first_name LIMIT 20`
- 컬럼: first_name→actor, last_name→actor

#### TC-07 ✅ JOIN
- 질문: 고객 이름, 이메일, 사는 도시 보여줘
- 실행 쿼리: `SELECT c.first_name, c.last_name, c.email, ci.city FROM customer AS c JOIN address AS a ON c.address_id = a.address_id JOIN city AS ci ON a.city_id = ci.city_id LIMIT 20`
- 컬럼: first_name→customer, last_name→customer, email→customer, city→city

#### TC-08 ✅ JOIN · 동명 컬럼
- 재실행 결과 (1차 실패: LLM CLI 네트워크 오류)
- 질문: 영화 제목과 장르 보여줘
- 실행 쿼리: `SELECT t1.title, t3.name FROM film AS t1 JOIN film_category AS t2 ON t1.film_id = t2.film_id JOIN category AS t3 ON t2.category_id = t3.category_id LIMIT 20`
- 컬럼: title→film, name→category

#### TC-09 ✅ JOIN · 동명 컬럼
- 질문: 영화 제목과 언어 보여줘
- 실행 쿼리: `SELECT t1.title, t2.name FROM film AS t1 JOIN language AS t2 ON t1.language_id = t2.language_id LIMIT 20`
- 컬럼: title→film, name→language

#### TC-10 ⚠️ JOIN · 동명 컬럼
- 질문: 매장별 관리자 이름과 매장 주소 알려줘
- 실행 쿼리: `SELECT s.store_id, CONCAT(st.first_name, ' ', st.last_name) AS manager_name, a.address FROM store AS s JOIN staff AS st ON s.manager_staff_id = st.staff_id JOIN address AS a ON s.address_id = a.address_id ORDER BY s.store_id LIMIT 20`
- 컬럼: store_id→store, manager_name→미매칭, address→address

#### TC-11 ✅ JOIN
- 질문: 최근 대여 기록을 영화 제목이랑 같이 보여줘
- 실행 쿼리: `SELECT r.rental_id, r.rental_date, r.return_date, f.title FROM rental AS r JOIN inventory AS i ON r.inventory_id = i.inventory_id JOIN film AS f ON i.film_id = f.film_id ORDER BY r.rental_date DESC LIMIT 20`
- 컬럼: rental_id→rental, rental_date→rental, return_date→rental, title→film

#### TC-12 ✅ 집계
- 질문: 등급별 영화 수 알려줘
- 실행 쿼리: `SELECT rating, COUNT(*) AS film_count FROM film GROUP BY rating ORDER BY rating LIMIT 20`
- 컬럼: rating→film, film_count→미매칭

#### TC-13 ✅ 집계 · JOIN
- 질문: 결제 금액 합계가 가장 큰 고객 10명 보여줘
- 실행 쿼리: `SELECT t1.customer_id, t1.first_name, t1.last_name, t1.total_amount FROM (SELECT c.customer_id, c.first_name, c.last_name, SUM(p.amount) AS total_amount, ROW_NUMBER() OVER (ORDER BY SUM(p.amount) DESC) AS rn FROM customer c JOIN payment p ON c.customer_id = p.customer_id GROUP BY c.customer_id, c.first_name, c.last_name) t1 WHERE t1.rn <= 10 ORDER BY t1.total_amount DESC LIMIT 20`
- 컬럼: customer_id→customer, first_name→customer, last_name→customer, total_amount→미매칭

#### TC-14 ✅ 결과 0건
- 질문: 2030년에 개봉한 영화 제목 보여줘
- 실행 쿼리: `SELECT title FROM film WHERE release_year = 2030 LIMIT 20`
- 컬럼: title→film
