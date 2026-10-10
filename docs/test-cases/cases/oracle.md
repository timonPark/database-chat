# oracle 테스트케이스 — HR

> 이 파일은 `cases/oracle.json` 에서 생성됩니다 (`node docs/test-cases/run-cases.mjs --db oracle --list`). 직접 수정하지 말고 JSON 을 고친 뒤 다시 생성하세요.

- 샘플 데이터: npm run seed → oracle/db-sample-schemas human_resources (HR 스키마), 접속 계정 hr / SERVICE FREEPDB1
- 테이블: `COUNTRIES`, `DEPARTMENTS`, `EMPLOYEES`, `JOBS`, `JOB_HISTORY`, `LOCATIONS`, `REGIONS`
- Oracle 은 따옴표 없는 식별자를 대문자로 저장하므로 결과 key 가 대문자(EMPLOYEE_ID)로 온다. 판정은 대소문자를 구분하지 않는다.
- 스키마 파일 이름은 user_tables 기준 대문자 (tables/EMPLOYEES.md) — source 도 대문자

## 자연어 케이스 (`/chat`)

| ID | 구분 | 질문 | 예상 쿼리 | 기대 |
|---|---|---|---|---|
| TC-01 | 회귀 | 직원 목록 5명 보여줘 | `SELECT * FROM employees FETCH FIRST 5 ROWS ONLY` | `full` · 매칭 테이블 ⊂ {EMPLOYEES} |
| TC-02 | 회귀 | 급여가 10000 이상인 직원 이름과 급여를 급여 높은 순으로 보여줘 | `SELECT first_name, last_name, salary FROM employees WHERE salary >= 10000 ORDER BY salary DESC` | `full` · FIRST_NAME→EMPLOYEES, SALARY→EMPLOYEES · 매칭 테이블 ⊂ {EMPLOYEES} |
| TC-03 | 회귀 · 서브쿼리 | 평균 급여보다 많이 받는 직원 보여줘 | `SELECT employee_id, first_name, last_name, salary FROM employees WHERE salary > (SELECT AVG(salary) FROM employees)` | `full` · 매칭 테이블 ⊂ {EMPLOYEES} |
| TC-04 | JOIN | 직원 이름과 소속 부서명 보여줘 | `SELECT e.first_name, e.last_name, d.department_name FROM employees e JOIN departments d ON d.department_id = e.department_id` | `full` · FIRST_NAME→EMPLOYEES, DEPARTMENT_NAME→DEPARTMENTS · 매칭 테이블 ⊂ {EMPLOYEES, DEPARTMENTS} |
| TC-05 | JOIN (상대 컬럼만) | Seattle 에 있는 부서 이름 알려줘 | `SELECT d.department_name FROM locations l JOIN departments d ON d.location_id = l.location_id WHERE l.city = 'Seattle'` | `full` · DEPARTMENT_NAME→DEPARTMENTS · 매칭 테이블 ⊂ {DEPARTMENTS, LOCATIONS} |
| TC-06 | JOIN | 직원 이름과 직무명 보여줘 | `SELECT e.first_name, e.last_name, j.job_title FROM employees e JOIN jobs j ON j.job_id = e.job_id` | `full` · FIRST_NAME→EMPLOYEES, JOB_TITLE→JOBS · 매칭 테이블 ⊂ {EMPLOYEES, JOBS} |
| TC-07 | JOIN · 동명 컬럼 | 부서별 부서장 이름 보여줘 | `SELECT d.department_name, e.first_name, e.last_name FROM departments d JOIN employees e ON e.employee_id = d.manager_id` | `full` · DEPARTMENT_NAME→DEPARTMENTS, FIRST_NAME→EMPLOYEES · 매칭 테이블 ⊂ {DEPARTMENTS, EMPLOYEES} |
| TC-08 | JOIN (3개 테이블) | 부서명과 부서가 있는 도시, 국가 이름 보여줘 | `SELECT d.department_name, l.city, c.country_name FROM departments d JOIN locations l ON l.location_id = d.location_id JOIN countries c ON c.country_id = l.country_id` | `full` · DEPARTMENT_NAME→DEPARTMENTS, CITY→LOCATIONS, COUNTRY_NAME→COUNTRIES · 매칭 테이블 ⊂ {DEPARTMENTS, LOCATIONS, COUNTRIES} |
| TC-09 | JOIN (셀프 조인) | 직원 이름과 그 직원의 매니저 이름 보여줘 | `SELECT e.first_name, e.last_name, m.first_name AS manager_first_name, m.last_name AS manager_last_name FROM employees e JOIN employees m ON m.employee_id = e.manager_id` | `full` · 매칭 테이블 ⊂ {EMPLOYEES} |
| TC-10 | JOIN | 직무 이력이 있는 직원의 이름, 시작일, 종료일, 직무 보여줘 | `SELECT e.first_name, e.last_name, h.start_date, h.end_date, h.job_id FROM job_history h JOIN employees e ON e.employee_id = h.employee_id` | `full` · START_DATE→JOB_HISTORY, FIRST_NAME→EMPLOYEES · 매칭 테이블 ⊂ {JOB_HISTORY, EMPLOYEES, JOBS} |
| TC-11 | 집계 | 부서별 직원 수 알려줘 | `SELECT department_id, COUNT(*) AS employee_count FROM employees GROUP BY department_id` | `partial` · 매칭 테이블 ⊂ {EMPLOYEES, DEPARTMENTS} |
| TC-12 | 집계 · JOIN | 부서별 평균 급여를 높은 순으로 보여줘 | `SELECT d.department_name, AVG(e.salary) AS avg_salary FROM employees e JOIN departments d ON d.department_id = e.department_id GROUP BY d.department_name ORDER BY avg_salary DESC` | `partial` · DEPARTMENT_NAME→DEPARTMENTS · 매칭 테이블 ⊂ {EMPLOYEES, DEPARTMENTS} |
| TC-13 | 결과 0건 | 급여가 100만 이상인 직원 이름 보여줘 | `SELECT first_name, last_name FROM employees WHERE salary >= 1000000` | `full` · 매칭 테이블 ⊂ {EMPLOYEES} · 0건 |

## 직접 쿼리 케이스 (API)

| ID | 구분 | 쿼리 | 기대 |
|---|---|---|---|
| D-01 | 따옴표 식별자 | `SELECT * FROM "EMPLOYEES" FETCH FIRST 5 ROWS ONLY` | `full` · 전 컬럼 source=EMPLOYEES |
| D-02 | 스키마 접두사 | `SELECT * FROM hr.employees FETCH FIRST 5 ROWS ONLY` | `full` · 전 컬럼 source=EMPLOYEES |
| D-03 | 소문자 참조 · 대문자 결과 | `SELECT e.employee_id, e.first_name, e.salary FROM employees e FETCH FIRST 5 ROWS ONLY` | `full` · EMPLOYEE_ID→EMPLOYEES, FIRST_NAME→EMPLOYEES, SALARY→EMPLOYEES |
| D-04 | JOIN alias.* | `SELECT d.* FROM employees e JOIN departments d ON d.department_id = e.department_id FETCH FIRST 5 ROWS ONLY` | `full` · 전 컬럼 source=DEPARTMENTS |
| D-05 | JOIN · 동명 컬럼 | `SELECT d.department_name, d.manager_id, e.first_name FROM departments d JOIN employees e ON e.employee_id = d.manager_id` | `full` · DEPARTMENT_NAME→DEPARTMENTS, MANAGER_ID→DEPARTMENTS, FIRST_NAME→EMPLOYEES |
| D-06 | 컬럼 별칭 | `SELECT e.first_name AS given_name, j.job_title AS title FROM employees e JOIN jobs j ON j.job_id = e.job_id FETCH FIRST 5 ROWS ONLY` | `full` · GIVEN_NAME→EMPLOYEES, TITLE→JOBS |
| D-07 | 콤마 조인 | `SELECT l.city, c.country_name FROM locations l, countries c WHERE c.country_id = l.country_id` | `full` · CITY→LOCATIONS, COUNTRY_NAME→COUNTRIES |
| D-08 | ROWNUM 서브쿼리 | `SELECT * FROM (SELECT employee_id, first_name, salary FROM employees ORDER BY salary DESC) WHERE ROWNUM <= 5` | `full` · 전 컬럼 source=EMPLOYEES |
| D-09 | 집계 | `SELECT department_id, COUNT(*) AS employee_count FROM employees GROUP BY department_id` | `partial` · DEPARTMENT_ID→EMPLOYEES · 미매칭 [EMPLOYEE_COUNT] |
| D-10 | 결과 0건 헤더 | `SELECT first_name, salary FROM employees WHERE 1 = 0` | `full` · 전 컬럼 source=EMPLOYEES · 헤더 [first_name, salary] · 0건 |
| D-11 | CTE | `WITH dept AS (SELECT department_id, department_name FROM departments) SELECT e.first_name, d.department_name FROM employees e JOIN dept d ON d.department_id = e.department_id FETCH FIRST 5 ROWS ONLY` | `full` · FIRST_NAME→EMPLOYEES, DEPARTMENT_NAME→DEPARTMENTS · WITH 미허용 템플릿은 400 거부가 기대 결과 |
