# mac · claude · oracle 테스트 결과

> 이슈: #198 · 검증표: #189 · 재측정: #223 (동명 컬럼 key 매칭 수정 후)

## 결론

| 항목 | 내용 |
|---|---|
| 실행일 · 실행자 | 2026-10-12 · Claude Code |
| 설치 폴더 · 모델 | `claude-oracle` (저장소 루트, `main` 템플릿 + #223 `build-columns.ts` 반영) · `claude-haiku-4-5-20251001` |
| 샘플 데이터 | README 1장 기준 — Docker Oracle Free 23 · `FREEPDB1` / 계정 `hr` · HR 7 tables, `tables/*.md` 7/7 |
| 결과 | ✅ 26 · ⚠️ 0 · ❌ 0 (기존 24건 + D-12 · D-13) |
| 최종 판정 | 통과 |

## REVIEW · FAIL 항목

없음.

- #198 최초 실행에서 TC-09 (셀프 조인) 가 ⚠️ — node-oracledb 가 동명 컬럼 key 를 `FIRST_NAME_1` 로 바꿔 미매칭. #223 수정 후 재측정
- TC-09: `e.FIRST_NAME, e.LAST_NAME, m.FIRST_NAME, m.LAST_NAME` (별칭 없음) → `FIRST_NAME_1` · `LAST_NAME_1` 이 EMPLOYEES 로 매칭

## 실행기 보고서

`node docs/test-cases/run-cases.mjs --db oracle --project claude-oracle --url http://localhost:3112 --out docs/test-cases/results/mac-claude-oracle.md`

> 3종을 포트만 나눠 (`PORT=3111` · `3112` · `3113`) 동시에 실행

- 실행: 2026-10-12T06:49:21.578Z · OS: darwin · 서버: http://localhost:3112
- 설치 폴더: `~/Project/database-chat/claude-oracle` · provider: claude · 모델: claude-haiku-4-5-20251001 · WITH 허용: true
- 샘플 데이터: HR
- 결과: ✅ 24 · ⚠️ 0 · ❌ 0 (총 24)

| ID | 구분 | 결과 | confidence | 미매칭 | 비고 |
|---|---|---|---|---|---|
| D-01 | 따옴표 식별자 | ✅ | full |  |  |
| D-02 | 스키마 접두사 | ✅ | full |  |  |
| D-03 | 소문자 참조 · 대문자 결과 | ✅ | full |  |  |
| D-04 | JOIN alias.* | ✅ | full |  |  |
| D-05 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| D-06 | 컬럼 별칭 | ✅ | full |  |  |
| D-07 | 콤마 조인 | ✅ | full |  |  |
| D-08 | ROWNUM 서브쿼리 | ✅ | full |  |  |
| D-09 | 집계 | ✅ | partial | EMPLOYEE_COUNT |  |
| D-10 | 결과 0건 헤더 | ✅ | full |  |  |
| D-11 | CTE | ✅ | full |  |  |
| TC-01 | 회귀 | ✅ | full |  |  |
| TC-02 | 회귀 | ✅ | full |  |  |
| TC-03 | 회귀 · 서브쿼리 | ✅ | full |  |  |
| TC-04 | JOIN | ✅ | full |  |  |
| TC-05 | JOIN (상대 컬럼만) | ✅ | full |  |  |
| TC-06 | JOIN | ✅ | full |  |  |
| TC-07 | JOIN · 동명 컬럼 | ✅ | full |  |  |
| TC-08 | JOIN (3개 테이블) | ✅ | full |  |  |
| TC-09 | JOIN (셀프 조인) | ✅ | full |  |  |
| TC-10 | JOIN | ✅ | full |  |  |
| TC-11 | 집계 | ✅ | partial | EMPLOYEE_COUNT |  |
| TC-12 | 집계 · JOIN | ✅ | partial | AVG_SALARY |  |
| TC-13 | 결과 0건 | ✅ | full |  |  |

## 상세

### D-01 ✅ 따옴표 식별자
- 실행 쿼리: `SELECT * FROM "EMPLOYEES" FETCH FIRST 5 ROWS ONLY`
- 컬럼: EMPLOYEE_ID→EMPLOYEES, FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES, EMAIL→EMPLOYEES, PHONE_NUMBER→EMPLOYEES, HIRE_DATE→EMPLOYEES, JOB_ID→EMPLOYEES, SALARY→EMPLOYEES, COMMISSION_PCT→EMPLOYEES, MANAGER_ID→EMPLOYEES, DEPARTMENT_ID→EMPLOYEES

### D-02 ✅ 스키마 접두사
- 실행 쿼리: `SELECT * FROM hr.employees FETCH FIRST 5 ROWS ONLY`
- 컬럼: EMPLOYEE_ID→EMPLOYEES, FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES, EMAIL→EMPLOYEES, PHONE_NUMBER→EMPLOYEES, HIRE_DATE→EMPLOYEES, JOB_ID→EMPLOYEES, SALARY→EMPLOYEES, COMMISSION_PCT→EMPLOYEES, MANAGER_ID→EMPLOYEES, DEPARTMENT_ID→EMPLOYEES

### D-03 ✅ 소문자 참조 · 대문자 결과
- 실행 쿼리: `SELECT e.employee_id, e.first_name, e.salary FROM employees e FETCH FIRST 5 ROWS ONLY`
- 컬럼: EMPLOYEE_ID→EMPLOYEES, FIRST_NAME→EMPLOYEES, SALARY→EMPLOYEES

### D-04 ✅ JOIN alias.*
- 실행 쿼리: `SELECT d.* FROM employees e JOIN departments d ON d.department_id = e.department_id FETCH FIRST 5 ROWS ONLY`
- 컬럼: DEPARTMENT_ID→DEPARTMENTS, DEPARTMENT_NAME→DEPARTMENTS, MANAGER_ID→DEPARTMENTS, LOCATION_ID→DEPARTMENTS

### D-05 ✅ JOIN · 동명 컬럼
- 실행 쿼리: `SELECT d.department_name, d.manager_id, e.first_name FROM departments d JOIN employees e ON e.employee_id = d.manager_id`
- 컬럼: DEPARTMENT_NAME→DEPARTMENTS, MANAGER_ID→DEPARTMENTS, FIRST_NAME→EMPLOYEES

### D-06 ✅ 컬럼 별칭
- 실행 쿼리: `SELECT e.first_name AS given_name, j.job_title AS title FROM employees e JOIN jobs j ON j.job_id = e.job_id FETCH FIRST 5 ROWS ONLY`
- 컬럼: GIVEN_NAME→EMPLOYEES, TITLE→JOBS

### D-07 ✅ 콤마 조인
- 실행 쿼리: `SELECT l.city, c.country_name FROM locations l, countries c WHERE c.country_id = l.country_id`
- 컬럼: CITY→LOCATIONS, COUNTRY_NAME→COUNTRIES

### D-08 ✅ ROWNUM 서브쿼리
- 실행 쿼리: `SELECT * FROM (SELECT employee_id, first_name, salary FROM employees ORDER BY salary DESC) WHERE ROWNUM <= 5`
- 컬럼: EMPLOYEE_ID→EMPLOYEES, FIRST_NAME→EMPLOYEES, SALARY→EMPLOYEES

### D-09 ✅ 집계
- 실행 쿼리: `SELECT department_id, COUNT(*) AS employee_count FROM employees GROUP BY department_id`
- 컬럼: DEPARTMENT_ID→EMPLOYEES, EMPLOYEE_COUNT→미매칭

### D-10 ✅ 결과 0건 헤더
- 실행 쿼리: `SELECT first_name, salary FROM employees WHERE 1 = 0`
- 컬럼: first_name→EMPLOYEES, salary→EMPLOYEES

### D-11 ✅ CTE
- 실행 쿼리: `WITH dept AS (SELECT department_id, department_name FROM departments) SELECT e.first_name, d.department_name FROM employees e JOIN dept d ON d.department_id = e.department_id FETCH FIRST 5 ROWS ONLY`
- 컬럼: FIRST_NAME→EMPLOYEES, DEPARTMENT_NAME→DEPARTMENTS

### TC-01 ✅ 회귀
- 질문: 직원 목록 5명 보여줘
- 실행 쿼리: `SELECT EMPLOYEE_ID, FIRST_NAME, LAST_NAME, EMAIL, SALARY, DEPARTMENT_ID FROM EMPLOYEES ORDER BY EMPLOYEE_ID FETCH FIRST 5 ROWS ONLY`
- 컬럼: EMPLOYEE_ID→EMPLOYEES, FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES, EMAIL→EMPLOYEES, SALARY→EMPLOYEES, DEPARTMENT_ID→EMPLOYEES

### TC-02 ✅ 회귀
- 질문: 급여가 10000 이상인 직원 이름과 급여를 급여 높은 순으로 보여줘
- 실행 쿼리: `SELECT FIRST_NAME, LAST_NAME, SALARY FROM EMPLOYEES WHERE SALARY >= 10000 ORDER BY SALARY DESC FETCH FIRST 20 ROWS ONLY`
- 컬럼: FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES, SALARY→EMPLOYEES

### TC-03 ✅ 회귀 · 서브쿼리
- 질문: 평균 급여보다 많이 받는 직원 보여줘
- 실행 쿼리: `SELECT EMPLOYEE_ID, FIRST_NAME, LAST_NAME, SALARY FROM EMPLOYEES WHERE SALARY > (SELECT AVG(SALARY) FROM EMPLOYEES) ORDER BY SALARY DESC FETCH FIRST 20 ROWS ONLY`
- 컬럼: EMPLOYEE_ID→EMPLOYEES, FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES, SALARY→EMPLOYEES

### TC-04 ✅ JOIN
- 질문: 직원 이름과 소속 부서명 보여줘
- 실행 쿼리: `SELECT e.EMPLOYEE_ID, e.FIRST_NAME, e.LAST_NAME, d.DEPARTMENT_NAME FROM EMPLOYEES e LEFT JOIN DEPARTMENTS d ON e.DEPARTMENT_ID = d.DEPARTMENT_ID ORDER BY e.EMPLOYEE_ID FETCH FIRST 20 ROWS ONLY`
- 컬럼: EMPLOYEE_ID→EMPLOYEES, FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES, DEPARTMENT_NAME→DEPARTMENTS

### TC-05 ✅ JOIN (상대 컬럼만)
- 질문: Seattle 에 있는 부서 이름 알려줘
- 실행 쿼리: `SELECT d.DEPARTMENT_NAME FROM DEPARTMENTS d JOIN LOCATIONS l ON d.LOCATION_ID = l.LOCATION_ID WHERE l.CITY = 'Seattle' ORDER BY d.DEPARTMENT_NAME FETCH FIRST 20 ROWS ONLY`
- 컬럼: DEPARTMENT_NAME→DEPARTMENTS

### TC-06 ✅ JOIN
- 질문: 직원 이름과 직무명 보여줘
- 실행 쿼리: `SELECT e.FIRST_NAME, e.LAST_NAME, j.JOB_TITLE FROM EMPLOYEES e JOIN JOBS j ON e.JOB_ID = j.JOB_ID ORDER BY e.EMPLOYEE_ID FETCH FIRST 20 ROWS ONLY`
- 컬럼: FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES, JOB_TITLE→JOBS

### TC-07 ✅ JOIN · 동명 컬럼
- 질문: 부서별 부서장 이름 보여줘
- 실행 쿼리: `SELECT d.DEPARTMENT_NAME, e.FIRST_NAME, e.LAST_NAME FROM DEPARTMENTS d LEFT JOIN EMPLOYEES e ON d.MANAGER_ID = e.EMPLOYEE_ID ORDER BY d.DEPARTMENT_NAME FETCH FIRST 20 ROWS ONLY`
- 컬럼: DEPARTMENT_NAME→DEPARTMENTS, FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES

### TC-08 ✅ JOIN (3개 테이블)
- 질문: 부서명과 부서가 있는 도시, 국가 이름 보여줘
- 실행 쿼리: `SELECT d.DEPARTMENT_NAME, l.CITY, c.COUNTRY_NAME FROM DEPARTMENTS d JOIN LOCATIONS l ON d.LOCATION_ID = l.LOCATION_ID JOIN COUNTRIES c ON l.COUNTRY_ID = c.COUNTRY_ID ORDER BY d.DEPARTMENT_NAME FETCH FIRST 20 ROWS ONLY`
- 컬럼: DEPARTMENT_NAME→DEPARTMENTS, CITY→LOCATIONS, COUNTRY_NAME→COUNTRIES

### TC-09 ✅ JOIN (셀프 조인)
- 질문: 직원 이름과 그 직원의 매니저 이름 보여줘
- 실행 쿼리: `SELECT e.FIRST_NAME, e.LAST_NAME, m.FIRST_NAME, m.LAST_NAME FROM EMPLOYEES e LEFT JOIN EMPLOYEES m ON e.MANAGER_ID = m.EMPLOYEE_ID ORDER BY e.FIRST_NAME, e.LAST_NAME FETCH FIRST 20 ROWS ONLY`
- 컬럼: FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES, FIRST_NAME_1→EMPLOYEES, LAST_NAME_1→EMPLOYEES

### TC-10 ✅ JOIN
- 질문: 직무 이력이 있는 직원의 이름, 시작일, 종료일, 직무 보여줘
- 실행 쿼리: `SELECT e.FIRST_NAME, e.LAST_NAME, jh.START_DATE, jh.END_DATE, j.JOB_TITLE FROM EMPLOYEES e JOIN JOB_HISTORY jh ON e.EMPLOYEE_ID = jh.EMPLOYEE_ID JOIN JOBS j ON jh.JOB_ID = j.JOB_ID ORDER BY e.EMPLOYEE_ID, jh.START_DATE FETCH FIRST 20 ROWS ONLY`
- 컬럼: FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES, START_DATE→JOB_HISTORY, END_DATE→JOB_HISTORY, JOB_TITLE→JOBS

### TC-11 ✅ 집계
- 질문: 부서별 직원 수 알려줘
- 실행 쿼리: `SELECT d.DEPARTMENT_ID, d.DEPARTMENT_NAME, COUNT(e.EMPLOYEE_ID) AS EMPLOYEE_COUNT FROM DEPARTMENTS d LEFT JOIN EMPLOYEES e ON d.DEPARTMENT_ID = e.DEPARTMENT_ID GROUP BY d.DEPARTMENT_ID, d.DEPARTMENT_NAME ORDER BY d.DEPARTMENT_ID FETCH FIRST 100 ROWS ONLY`
- 컬럼: DEPARTMENT_ID→DEPARTMENTS, DEPARTMENT_NAME→DEPARTMENTS, EMPLOYEE_COUNT→미매칭

### TC-12 ✅ 집계 · JOIN
- 질문: 부서별 평균 급여를 높은 순으로 보여줘
- 실행 쿼리: `SELECT d.DEPARTMENT_ID, d.DEPARTMENT_NAME, AVG(e.SALARY) as avg_salary FROM EMPLOYEES e JOIN DEPARTMENTS d ON e.DEPARTMENT_ID = d.DEPARTMENT_ID GROUP BY d.DEPARTMENT_ID, d.DEPARTMENT_NAME ORDER BY AVG(e.SALARY) DESC FETCH FIRST 20 ROWS ONLY`
- 컬럼: DEPARTMENT_ID→DEPARTMENTS, DEPARTMENT_NAME→DEPARTMENTS, AVG_SALARY→미매칭

### TC-13 ✅ 결과 0건
- 질문: 급여가 100만 이상인 직원 이름 보여줘
- 실행 쿼리: `SELECT FIRST_NAME, LAST_NAME FROM EMPLOYEES WHERE SALARY >= 1000000 ORDER BY SALARY DESC FETCH FIRST 20 ROWS ONLY`
- 컬럼: FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES

### 추가 케이스 (D-12 · D-13, #223)

`node docs/test-cases/run-cases.mjs --db oracle --project claude-oracle --url http://localhost:3112 --skip-chat --only D-12,D-13`

- 실행: 2026-10-12T06:50:14.786Z · OS: darwin · 서버: http://localhost:3112
- 설치 폴더: `~/Project/database-chat/claude-oracle` · provider: claude · 모델: claude-haiku-4-5-20251001 · WITH 허용: true
- 샘플 데이터: HR
- 결과: ✅ 2 · ⚠️ 0 · ❌ 0 (총 2)

| ID | 구분 | 결과 | confidence | 미매칭 | 비고 |
|---|---|---|---|---|---|
| D-12 | 동명 컬럼 중복 (셀프 조인) | ✅ | full |  |  |
| D-13 | 동명 컬럼 중복 (다른 테이블) | ✅ | full |  |  |

## 상세

### D-12 ✅ 동명 컬럼 중복 (셀프 조인)
- 실행 쿼리: `SELECT e.first_name, e.last_name, m.first_name, m.last_name FROM employees e JOIN employees m ON m.employee_id = e.manager_id FETCH FIRST 5 ROWS ONLY`
- 컬럼: FIRST_NAME→EMPLOYEES, LAST_NAME→EMPLOYEES, FIRST_NAME_1→EMPLOYEES, LAST_NAME_1→EMPLOYEES

### D-13 ✅ 동명 컬럼 중복 (다른 테이블)
- 실행 쿼리: `SELECT d.department_name, d.manager_id, e.manager_id FROM departments d JOIN employees e ON e.employee_id = d.manager_id`
- 컬럼: DEPARTMENT_NAME→DEPARTMENTS, MANAGER_ID→DEPARTMENTS, MANAGER_ID_1→EMPLOYEES
