# mac · gemini · mysql 테스트 결과

> 이슈: #196 · 검증표: #189

## 결론

| 항목 | 내용 |
|---|---|
| 실행일 · 실행자 | 2026-10-10 · Claude Code |
| 설치 폴더 · 모델 | `gemini-mysql` (저장소 루트, `main` 템플릿 기준 — #178 · #203 반영) · `gemini-3.8-flash-medium` |
| 샘플 데이터 | README 1장 기준 — Docker MySQL 8.0 · `sakila` 16 tables, `npm run schema` 로 `tables/*.md` 16/16 생성 |
| 결과 | ✅ 26 · ⚠️ 0 · ❌ 0 |
| 최종 판정 | 통과 |

## REVIEW · FAIL 항목

없음

## 실행기 보고서

`node docs/test-cases/run-cases.mjs --db mysql --project gemini-mysql --out docs/test-cases/results/mac-gemini-mysql.md`

- 실행: 2026-10-10T11:45:10.530Z · OS: darwin · 서버: http://localhost:3111
- 설치 폴더: `~/Project/database-chat/gemini-mysql` · provider: gemini · 모델: gemini-3.8-flash-medium · WITH 허용: false
- 샘플 데이터: sakila
- 결과: ✅ 26 · ⚠️ 0 · ❌ 0 (총 26)

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
| D-11 | CTE | ✅ | — |  | 이 템플릿은 WITH 미허용 → 400 거부가 기대 결과 |
| D-12 | 민감 컬럼 | ✅ | full |  |  |
| TC-01 | 회귀 | ✅ | full |  |  |
| TC-02 | 회귀 | ✅ | full |  |  |
| TC-03 | 회귀 · 민감 컬럼 | ✅ | full |  |  |
| TC-04 | 회귀 · 서브쿼리 | ✅ | full |  |  |
| TC-05 | JOIN | ✅ | full |  |  |
| TC-06 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| TC-07 | JOIN | ✅ | full |  |  |
| TC-08 | JOIN · 동명 컬럼 | ✅ | full |  | name 컬럼 없음 (별칭 · 생략) |
| TC-09 | JOIN · 동명 컬럼 | ✅ | full |  | name 컬럼 없음 (별칭 · 생략) |
| TC-10 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| TC-11 | JOIN | ✅ | full |  |  |
| TC-12 | 집계 | ✅ | partial | film_count |  |
| TC-13 | 집계 · JOIN | ✅ | partial | total_amount |  |
| TC-14 | 결과 0건 | ✅ | full |  |  |

## 상세

### D-01 ✅ 따옴표 식별자
- 실행 쿼리: `SELECT * FROM `film` LIMIT 5`
- 컬럼: film_id→film, title→film, description→film, release_year→film, language_id→film, original_language_id→film, rental_duration→film, rental_rate→film, length→film, replacement_cost→film, rating→film, special_features→film, last_update→film

### D-02 ✅ DB 접두사
- 실행 쿼리: `SELECT * FROM sakila.film LIMIT 5`
- 컬럼: film_id→film, title→film, description→film, release_year→film, language_id→film, original_language_id→film, rental_duration→film, rental_rate→film, length→film, replacement_cost→film, rating→film, special_features→film, last_update→film

### D-03 ✅ JOIN alias.*
- 실행 쿼리: `SELECT a.* FROM film f JOIN film_actor fa ON fa.film_id = f.film_id JOIN actor a ON a.actor_id = fa.actor_id LIMIT 5`
- 컬럼: actor_id→actor, first_name→actor, last_name→actor, last_update→actor

### D-04 ✅ JOIN · 동명 컬럼
- 실행 쿼리: `SELECT s.store_id, st.first_name, st.last_name, ad.address FROM store s JOIN staff st ON st.staff_id = s.manager_staff_id JOIN address ad ON ad.address_id = s.address_id`
- 컬럼: store_id→store, first_name→staff, last_name→staff, address→address

### D-05 ✅ 컬럼 별칭
- 실행 쿼리: `SELECT c.first_name AS customer_name, c.email AS mail FROM customer c LIMIT 5`
- 컬럼: customer_name→customer, mail→customer

### D-06 ✅ 콤마 조인
- 실행 쿼리: `SELECT f.title, l.name FROM film f, language l WHERE l.language_id = f.language_id LIMIT 5`
- 컬럼: title→film, name→language

### D-07 ✅ 문자열 안 키워드
- 실행 쿼리: `SELECT title FROM film WHERE description LIKE '%JOIN actor FROM%' LIMIT 5`
- 컬럼: title→film

### D-08 ✅ FROM 서브쿼리
- 실행 쿼리: `SELECT * FROM (SELECT title, rating FROM film ORDER BY length DESC LIMIT 5) AS t`
- 컬럼: title→film, rating→film

### D-09 ✅ 집계
- 실행 쿼리: `SELECT rating, COUNT(*) AS film_count FROM film GROUP BY rating`
- 컬럼: rating→film, film_count→미매칭

### D-10 ✅ 결과 0건 헤더
- 실행 쿼리: `SELECT title, release_year FROM film WHERE 1 = 0`
- 컬럼: title→film, release_year→film

### D-11 ✅ CTE
- 실행 쿼리: `WITH r AS (SELECT customer_id FROM rental) SELECT * FROM customer WHERE customer_id IN (SELECT customer_id FROM r) LIMIT 5`
- 컬럼: —

### D-12 ✅ 민감 컬럼
- 실행 쿼리: `SELECT * FROM staff`
- 컬럼: staff_id→staff, first_name→staff, last_name→staff, address_id→staff, picture→staff, email→staff, store_id→staff, active→staff, username→staff, last_update→staff

### TC-01 ✅ 회귀
- 질문: 영화 목록 5개 보여줘
- 실행 쿼리: `SELECT film_id, title, release_year, rental_rate, length, rating FROM film LIMIT 5`
- 컬럼: film_id→film, title→film, release_year→film, rental_rate→film, length→film, rating→film

### TC-02 ✅ 회귀
- 질문: R 등급 영화 중 상영시간이 긴 순서로 제목이랑 상영시간 보여줘
- 실행 쿼리: `SELECT title, length FROM film WHERE rating = 'R' ORDER BY length DESC LIMIT 20`
- 컬럼: title→film, length→film

### TC-03 ✅ 회귀 · 민감 컬럼
- 질문: 직원 정보 전부 보여줘
- 실행 쿼리: `SELECT staff_id, first_name, last_name, address_id, email, store_id, active, username FROM staff LIMIT 20`
- 컬럼: staff_id→staff, first_name→staff, last_name→staff, address_id→staff, email→staff, store_id→staff, active→staff, username→staff

### TC-04 ✅ 회귀 · 서브쿼리
- 질문: 재고가 하나도 없는 영화 알려줘
- 실행 쿼리: `SELECT t1.film_id, t1.title, t1.release_year, t1.rating FROM film t1 LEFT JOIN inventory t2 ON t1.film_id = t2.film_id WHERE t2.inventory_id IS NULL ORDER BY t1.film_id LIMIT 20`
- 컬럼: film_id→film, title→film, release_year→film, rating→film

### TC-05 ✅ JOIN
- 질문: 배우 PENELOPE GUINESS 가 출연한 영화 제목 알려줘
- 실행 쿼리: `SELECT t1.title FROM film t1 JOIN film_actor t2 ON t1.film_id = t2.film_id JOIN actor t3 ON t2.actor_id = t3.actor_id WHERE t3.first_name = 'PENELOPE' AND t3.last_name = 'GUINESS' LIMIT 20`
- 컬럼: title→film

### TC-06 ✅ JOIN · 동명 컬럼
- 질문: ACADEMY DINOSAUR 영화에 출연한 배우 이름 알려줘
- 실행 쿼리: `SELECT t1.first_name, t1.last_name FROM actor t1 JOIN film_actor t2 ON t1.actor_id = t2.actor_id JOIN film t3 ON t2.film_id = t3.film_id WHERE t3.title = 'ACADEMY DINOSAUR' LIMIT 20`
- 컬럼: first_name→actor, last_name→actor

### TC-07 ✅ JOIN
- 질문: 고객 이름, 이메일, 사는 도시 보여줘
- 실행 쿼리: `SELECT t1.first_name, t1.last_name, t1.email, t3.city FROM customer t1 JOIN address t2 ON t1.address_id = t2.address_id JOIN city t3 ON t2.city_id = t3.city_id LIMIT 20`
- 컬럼: first_name→customer, last_name→customer, email→customer, city→city

### TC-08 ✅ JOIN · 동명 컬럼
- 질문: 영화 제목과 장르 보여줘
- 실행 쿼리: `SELECT t1.title, t3.name AS category_name FROM film t1 JOIN film_category t2 ON t1.film_id = t2.film_id JOIN category t3 ON t2.category_id = t3.category_id LIMIT 20`
- 컬럼: title→film, category_name→category

### TC-09 ✅ JOIN · 동명 컬럼
- 질문: 영화 제목과 언어 보여줘
- 실행 쿼리: `SELECT t1.title, t2.name AS language FROM film t1 JOIN language t2 ON t1.language_id = t2.language_id LIMIT 20`
- 컬럼: title→film, language→language

### TC-10 ✅ JOIN · 동명 컬럼
- 질문: 매장별 관리자 이름과 매장 주소 알려줘
- 실행 쿼리: `SELECT t1.store_id, t2.first_name, t2.last_name, t3.address FROM store t1 JOIN staff t2 ON t1.manager_staff_id = t2.staff_id JOIN address t3 ON t1.address_id = t3.address_id LIMIT 20`
- 컬럼: store_id→store, first_name→staff, last_name→staff, address→address

### TC-11 ✅ JOIN
- 질문: 최근 대여 기록을 영화 제목이랑 같이 보여줘
- 실행 쿼리: `SELECT t1.rental_id, t1.rental_date, t3.title, t1.customer_id, t1.return_date FROM rental t1 JOIN inventory t2 ON t1.inventory_id = t2.inventory_id JOIN film t3 ON t2.film_id = t3.film_id ORDER BY t1.rental_date DESC LIMIT 20`
- 컬럼: rental_id→rental, rental_date→rental, title→film, customer_id→rental, return_date→rental

### TC-12 ✅ 집계
- 질문: 등급별 영화 수 알려줘
- 실행 쿼리: `SELECT rating, COUNT(*) AS film_count FROM film GROUP BY rating ORDER BY film_count DESC LIMIT 20`
- 컬럼: rating→film, film_count→미매칭

### TC-13 ✅ 집계 · JOIN
- 질문: 결제 금액 합계가 가장 큰 고객 10명 보여줘
- 실행 쿼리: `SELECT t1.customer_id, t1.first_name, t1.last_name, SUM(t2.amount) AS total_amount FROM customer t1 JOIN payment t2 ON t1.customer_id = t2.customer_id GROUP BY t1.customer_id, t1.first_name, t1.last_name ORDER BY total_amount DESC LIMIT 20`
- 컬럼: customer_id→customer, first_name→customer, last_name→customer, total_amount→미매칭

### TC-14 ✅ 결과 0건
- 질문: 2030년에 개봉한 영화 제목 보여줘
- 실행 쿼리: `SELECT title FROM film WHERE release_year = 2030 LIMIT 20`
- 컬럼: title→film
