# postgresql 테스트케이스 — dvdrental

> 이 파일은 `cases/postgresql.json` 에서 생성됩니다 (`node docs/test-cases/run-cases.mjs --db postgresql --list`). 직접 수정하지 말고 JSON 을 고친 뒤 다시 생성하세요.

- 샘플 데이터: npm run seed → PostgreSQL Tutorial dvdrental (Sakila 계열 구조), DB_DATABASE=dvdrental
- 테이블: `actor`, `address`, `category`, `city`, `country`, `customer`, `film`, `film_actor`, `film_category`, `inventory`, `language`, `payment`, `rental`, `staff`, `store`

## 자연어 케이스 (`/chat`)

| ID | 구분 | 질문 | 예상 쿼리 | 기대 |
|---|---|---|---|---|
| TC-01 | 회귀 | 영화 목록 5개 보여줘 | `SELECT * FROM film LIMIT 5` | `full` · 매칭 테이블 ⊂ {film} |
| TC-02 | 회귀 | R 등급 영화 중 상영시간이 긴 순서로 제목이랑 상영시간 보여줘 | `SELECT title, length, rating FROM film WHERE rating = 'R' ORDER BY length DESC` | `full` · title→film, length→film · 매칭 테이블 ⊂ {film} |
| TC-03 | 회귀 · 민감 컬럼 | 직원 정보 전부 보여줘 | `SELECT * FROM staff` | `full` · 매칭 테이블 ⊂ {staff} · password 미노출 |
| TC-04 | 회귀 · 서브쿼리 | 재고가 하나도 없는 영화 알려줘 | `SELECT f.film_id, f.title FROM film f WHERE f.film_id NOT IN (SELECT i.film_id FROM inventory i)` | `full` · title→film · 매칭 테이블 ⊂ {film, inventory} |
| TC-05 | JOIN | 배우 Penelope Guiness 가 출연한 영화 제목 알려줘 | `SELECT f.title FROM actor a JOIN film_actor fa ON fa.actor_id = a.actor_id JOIN film f ON f.film_id = fa.film_id WHERE a.first_name = 'Penelope' AND a.last_name = 'Guiness'` | `full` · title→film · 매칭 테이블 ⊂ {film, actor, film_actor} |
| TC-06 | JOIN · 동명 컬럼 | Academy Dinosaur 영화에 출연한 배우 이름 알려줘 | `SELECT a.first_name, a.last_name FROM film f JOIN film_actor fa ON fa.film_id = f.film_id JOIN actor a ON a.actor_id = fa.actor_id WHERE f.title = 'Academy Dinosaur'` | `full` · first_name→actor, last_name→actor · 매칭 테이블 ⊂ {actor, film, film_actor} |
| TC-07 | JOIN | 고객 이름, 이메일, 사는 도시 보여줘 | `SELECT c.first_name, c.last_name, c.email, ci.city FROM customer c JOIN address ad ON ad.address_id = c.address_id JOIN city ci ON ci.city_id = ad.city_id` | `full` · first_name→customer, email→customer, city→city · 매칭 테이블 ⊂ {customer, address, city} |
| TC-08 | JOIN · 동명 컬럼 | 영화 제목과 장르 보여줘 | `SELECT f.title, c.name FROM film f JOIN film_category fc ON fc.film_id = f.film_id JOIN category c ON c.category_id = fc.category_id` | `full` · title→film, name→category · 매칭 테이블 ⊂ {film, category, film_category} |
| TC-09 | JOIN · 동명 컬럼 | 영화 제목과 언어 보여줘 | `SELECT f.title, l.name FROM film f JOIN language l ON l.language_id = f.language_id` | `full` · title→film, name→language · 매칭 테이블 ⊂ {film, language} |
| TC-10 | JOIN · 동명 컬럼 | 매장별 관리자 이름과 매장 주소 알려줘 | `SELECT s.store_id, st.first_name, st.last_name, ad.address FROM store s JOIN staff st ON st.staff_id = s.manager_staff_id JOIN address ad ON ad.address_id = s.address_id` | `full` · first_name→staff, address→address · 매칭 테이블 ⊂ {store, staff, address} |
| TC-11 | JOIN | 최근 결제 내역을 고객 이름과 같이 보여줘 | `SELECT p.payment_id, p.amount, p.payment_date, c.first_name, c.last_name FROM payment p JOIN customer c ON c.customer_id = p.customer_id ORDER BY p.payment_date DESC` | `full` · amount→payment, first_name→customer · 매칭 테이블 ⊂ {payment, customer} |
| TC-12 | 집계 | 등급별 영화 수 알려줘 | `SELECT rating, COUNT(*) AS film_count FROM film GROUP BY rating` | `partial` · rating→film · 매칭 테이블 ⊂ {film} |
| TC-13 | 집계 · JOIN | 장르별 영화 수 많은 순으로 보여줘 | `SELECT c.name, COUNT(*) AS film_count FROM category c JOIN film_category fc ON fc.category_id = c.category_id GROUP BY c.name ORDER BY film_count DESC` | `partial` · name→category · 매칭 테이블 ⊂ {category, film_category} |
| TC-14 | 결과 0건 | 2030년에 개봉한 영화 제목 보여줘 | `SELECT title FROM film WHERE release_year = 2030` | `full` · 매칭 테이블 ⊂ {film} · 0건 |

## 직접 쿼리 케이스 (API)

| ID | 구분 | 쿼리 | 기대 |
|---|---|---|---|
| D-01 | 따옴표 식별자 | `SELECT * FROM "film" LIMIT 5` | `full` · 전 컬럼 source=film |
| D-02 | 스키마 접두사 | `SELECT * FROM public.film LIMIT 5` | `full` · 전 컬럼 source=film |
| D-03 | JOIN alias.* | `SELECT a.* FROM film f JOIN film_actor fa ON fa.film_id = f.film_id JOIN actor a ON a.actor_id = fa.actor_id LIMIT 5` | `full` · 전 컬럼 source=actor |
| D-04 | JOIN · 동명 컬럼 | `SELECT s.store_id, st.first_name, st.last_name, ad.address FROM store s JOIN staff st ON st.staff_id = s.manager_staff_id JOIN address ad ON ad.address_id = s.address_id` | `full` · store_id→store, first_name→staff, last_name→staff, address→address |
| D-05 | 컬럼 별칭 | `SELECT c.first_name AS customer_name, c.email AS "mail" FROM customer AS c LIMIT 5` | `full` · customer_name→customer, mail→customer |
| D-06 | 콤마 조인 | `SELECT f.title, l.name FROM film f, language l WHERE l.language_id = f.language_id LIMIT 5` | `full` · title→film, name→language |
| D-07 | 문자열 안 키워드 | `SELECT title FROM film WHERE description LIKE '%JOIN actor FROM%' LIMIT 5` | `full` · title→film |
| D-08 | FROM 서브쿼리 | `SELECT * FROM (SELECT title, rating FROM film ORDER BY length DESC LIMIT 5) AS t` | `full` · 전 컬럼 source=film |
| D-09 | 집계 | `SELECT rating, COUNT(*) AS film_count FROM film GROUP BY rating` | `partial` · rating→film · 미매칭 [film_count] |
| D-10 | 결과 0건 헤더 | `SELECT title, release_year FROM film WHERE 1 = 0` | `full` · 전 컬럼 source=film · 헤더 [title, release_year] · 0건 |
| D-11 | CTE | `WITH top_films AS (SELECT film_id, title FROM film ORDER BY length DESC LIMIT 5) SELECT t.title, c.name FROM top_films t JOIN film_category fc ON fc.film_id = t.film_id JOIN category c ON c.category_id = fc.category_id` | `full` · title→film, name→category · WITH 미허용 템플릿은 400 거부가 기대 결과 |
| D-12 | 민감 컬럼 | `SELECT * FROM staff` | `full` · 전 컬럼 source=staff · password 미노출 |
