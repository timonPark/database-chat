# windows · codex · postgresql 테스트 결과

> 이슈: #192 · 검증표: #189

## 결론

| 항목 | 내용 |
|---|---|
| 실행일 · 실행자 | 2026-10-11 · Claude Code |
| 설치 폴더 · 모델 | `C:\database-chat\codex-postgresql` (`templates/windows/codex-postgresql` 와 server.ts · scripts · public · bat 동일) · `gpt-5.6-luna` |
| 샘플 데이터 | dvdrental (DB 서버 192.168.0.101 의 PostgreSQL), `tables/*.md` 15/15 |
| 결과 | ✅ 26 · ⚠️ 0 · ❌ 0 |
| 최종 판정 | 통과 |

## REVIEW · FAIL 항목

| ID | 등급 | 원인 분류 | 판단 · 조치 |
|---|---|---|---|
| — | — | — | 없음 |

## 실행기 보고서

`node docs/test-cases/run-cases.mjs --db postgresql --project codex-postgresql --out docs/test-cases/results/windows-codex-postgresql.md`

- 실행: 2026-10-11T10:16:48.995Z · OS: win32 · 서버: http://localhost:3111
- 설치 폴더: `C:\database-chat\codex-postgresql` · provider: codex · 모델: gpt-5.6-luna · WITH 허용: true
- 샘플 데이터: dvdrental
- 결과: ✅ 26 · ⚠️ 0 · ❌ 0 (총 26)

| ID | 구분 | 결과 | confidence | 미매칭 | 비고 |
|---|---|---|---|---|---|
| D-01 | 따옴표 식별자 | ✅ | full |  |  |
| D-02 | 스키마 접두사 | ✅ | full |  |  |
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
| TC-10 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| TC-11 | JOIN | ✅ | full |  |  |
| TC-12 | 집계 | ✅ | partial | film_count |  |
| TC-13 | 집계 · JOIN | ✅ | partial | film_count |  |
| TC-14 | 결과 0건 | ✅ | full |  |  |

## 상세

### D-01 ✅ 따옴표 식별자
- 실행 쿼리: `SELECT * FROM "film" LIMIT 5`
- 컬럼: film_id→film, title→film, description→film, release_year→film, language_id→film, rental_duration→film, rental_rate→film, length→film, replacement_cost→film, rating→film, last_update→film, special_features→film, fulltext→film

### D-02 ✅ 스키마 접두사
- 실행 쿼리: `SELECT * FROM public.film LIMIT 5`
- 컬럼: film_id→film, title→film, description→film, release_year→film, language_id→film, rental_duration→film, rental_rate→film, length→film, replacement_cost→film, rating→film, last_update→film, special_features→film, fulltext→film

### D-03 ✅ JOIN alias.*
- 실행 쿼리: `SELECT a.* FROM film f JOIN film_actor fa ON fa.film_id = f.film_id JOIN actor a ON a.actor_id = fa.actor_id LIMIT 5`
- 컬럼: actor_id→actor, first_name→actor, last_name→actor, last_update→actor

### D-04 ✅ JOIN · 동명 컬럼
- 실행 쿼리: `SELECT s.store_id, st.first_name, st.last_name, ad.address FROM store s JOIN staff st ON st.staff_id = s.manager_staff_id JOIN address ad ON ad.address_id = s.address_id`
- 컬럼: store_id→store, first_name→staff, last_name→staff, address→address

### D-05 ✅ 컬럼 별칭
- 실행 쿼리: `SELECT c.first_name AS customer_name, c.email AS "mail" FROM customer AS c LIMIT 5`
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
- 실행 쿼리: `WITH top_films AS (SELECT film_id, title FROM film ORDER BY length DESC LIMIT 5) SELECT t.title, c.name FROM top_films t JOIN film_category fc ON fc.film_id = t.film_id JOIN category c ON c.category_id = fc.category_id`
- 컬럼: title→film, name→category

### D-12 ✅ 민감 컬럼
- 실행 쿼리: `SELECT * FROM staff`
- 컬럼: staff_id→staff, first_name→staff, last_name→staff, address_id→staff, email→staff, store_id→staff, active→staff, username→staff, last_update→staff, picture→staff

### TC-01 ✅ 회귀
- 질문: 영화 목록 보여줘
- 실행 쿼리: `SELECT film_id, title, description, release_year, language_id, rental_duration, rental_rate, length, rating FROM public.film ORDER BY film_id LIMIT 20`
- 컬럼: film_id→film, title→film, description→film, release_year→film, language_id→film, rental_duration→film, rental_rate→film, length→film, rating→film

### TC-02 ✅ 회귀
- 질문: R 등급 영화 중 상영시간이 긴 순서로 제목이랑 상영시간 보여줘
- 실행 쿼리: `SELECT title, length FROM public.film WHERE rating = 'R' ORDER BY length DESC LIMIT 20`
- 컬럼: title→film, length→film

### TC-03 ✅ 회귀 · 민감 컬럼
- 질문: 직원 정보 전부 보여줘
- 실행 쿼리: `SELECT staff_id, first_name, last_name, address_id, store_id, active, username, email FROM public.staff LIMIT 20`
- 컬럼: staff_id→staff, first_name→staff, last_name→staff, address_id→staff, store_id→staff, active→staff, username→staff, email→staff

### TC-04 ✅ 회귀 · 서브쿼리
- 질문: 재고가 하나도 없는 영화 알려줘
- 실행 쿼리: `SELECT f.film_id, f.title, f.description, f.release_year, f.language_id, f.rental_duration, f.rental_rate, f.length, f.rating FROM public.film AS f WHERE NOT EXISTS (SELECT 1 FROM public.inventory AS i WHERE i.film_id = f.film_id) ORDER BY f.title LIMIT 20`
- 컬럼: film_id→film, title→film, description→film, release_year→film, language_id→film, rental_duration→film, rental_rate→film, length→film, rating→film

### TC-05 ✅ JOIN
- 질문: 배우 Penelope Guiness 가 출연한 영화 제목 알려줘
- 실행 쿼리: `SELECT f.title FROM public.film AS f JOIN public.film_actor AS fa ON f.film_id = fa.film_id JOIN public.actor AS a ON fa.actor_id = a.actor_id WHERE a.first_name = 'Penelope' AND a.last_name = 'Guiness' ORDER BY f.title LIMIT 20`
- 컬럼: title→film

### TC-06 ✅ JOIN · 동명 컬럼
- 질문: Academy Dinosaur 영화에 출연한 배우 이름 알려줘
- 실행 쿼리: `SELECT a.first_name, a.last_name FROM public.film AS t1 JOIN public.film_actor AS t2 ON t1.film_id = t2.film_id JOIN public.actor AS a ON t2.actor_id = a.actor_id WHERE t1.title = 'Academy Dinosaur' ORDER BY a.last_name, a.first_name LIMIT 20`
- 컬럼: first_name→actor, last_name→actor

### TC-07 ✅ JOIN
- 질문: 고객 이름, 이메일, 사는 도시 보여줘
- 실행 쿼리: `SELECT c.first_name, c.last_name, c.email, ci.city FROM public.customer AS c JOIN public.address AS a ON c.address_id = a.address_id JOIN public.city AS ci ON a.city_id = ci.city_id LIMIT 20`
- 컬럼: first_name→customer, last_name→customer, email→customer, city→city

### TC-08 ✅ JOIN · 동명 컬럼
- 질문: 영화 제목과 장르 보여줘
- 실행 쿼리: `SELECT t1.title, t3.name FROM public.film AS t1 JOIN public.film_category AS t2 ON t1.film_id = t2.film_id JOIN public.category AS t3 ON t2.category_id = t3.category_id LIMIT 20`
- 컬럼: title→film, name→category

### TC-09 ✅ JOIN · 동명 컬럼
- 질문: 영화 제목과 언어 보여줘
- 실행 쿼리: `SELECT t1.title, t2.name FROM public.film AS t1 JOIN public.language AS t2 ON t1.language_id = t2.language_id LIMIT 20`
- 컬럼: title→film, name→language

### TC-10 ✅ JOIN · 동명 컬럼
- 질문: 매장별 관리자 이름과 매장 주소 알려줘
- 실행 쿼리: `SELECT s.store_id, t1.first_name, t1.last_name, t2.address, t2.address2, t2.district, t2.postal_code, t2.phone FROM public.store AS s JOIN public.staff AS t1 ON s.manager_staff_id = t1.staff_id JOIN public.address AS t2 ON s.address_id = t2.address_id ORDER BY s.store_id LIMIT 20`
- 컬럼: store_id→store, first_name→staff, last_name→staff, address→address, address2→address, district→address, postal_code→address, phone→address

### TC-11 ✅ JOIN
- 질문: 최근 결제 내역을 고객 이름과 같이 보여줘
- 실행 쿼리: `SELECT t1.payment_id, t1.customer_id, t1.staff_id, t1.rental_id, t1.amount, t1.payment_date, t2.first_name, t2.last_name FROM public.payment AS t1 JOIN public.customer AS t2 ON t1.customer_id = t2.customer_id ORDER BY t1.payment_date DESC LIMIT 20`
- 컬럼: payment_id→payment, customer_id→payment, staff_id→payment, rental_id→payment, amount→payment, payment_date→payment, first_name→customer, last_name→customer

### TC-12 ✅ 집계
- 질문: 등급별 영화 수 알려줘
- 실행 쿼리: `SELECT rating, COUNT(*) AS film_count FROM public.film GROUP BY rating ORDER BY rating LIMIT 20`
- 컬럼: rating→film, film_count→미매칭

### TC-13 ✅ 집계 · JOIN
- 질문: 장르별 영화 수 많은 순으로 보여줘
- 실행 쿼리: `SELECT c.name, COUNT(fc.film_id) AS film_count FROM public.category AS c JOIN public.film_category AS fc ON c.category_id = fc.category_id GROUP BY c.category_id, c.name ORDER BY film_count DESC LIMIT 20`
- 컬럼: name→category, film_count→미매칭

### TC-14 ✅ 결과 0건
- 질문: 2030년에 개봉한 영화 제목 보여줘
- 실행 쿼리: `SELECT title FROM public.film WHERE release_year = 2030 LIMIT 20`
- 컬럼: title→film
