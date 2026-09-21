# MSSQL Type Conversion

`mssql` 노드 드라이버가 SQL Server 컬럼 값을 JavaScript로 변환하는 규칙을 정리합니다. 서버 측에서 별도 캐스팅 로직은 두지 않고 드라이버 기본 동작(`tedious` 프로토콜 파서)에 의존합니다 — 응답의 값 형태(문자열/숫자/Date)를 예측하려면 이 문서를 참고하세요.

기준 구현: [`templates/claude-mssql/server.ts:378`](../../templates/claude-mssql/server.ts) (`request.query()` 호출부)

## 컬럼명 대소문자

T-SQL 컬럼명 대소문자는 데이터베이스 collation에 따라 다릅니다. 기본 `SQL_Latin1_General_CP1_CI_AS`(대소문자 무시) 환경에서는 SQL에 쓴 대로 응답 키가 들어오는 경향이 있지만 서버 처리에 따라 편차가 있을 수 있으니, 프런트에서 컬럼명을 참조할 때는 `Object.keys` 결과를 그대로 사용하는 것이 안전합니다.

민감 컬럼 제거는 소문자 비교로 매칭하므로 collation 영향을 받지 않습니다 — [`query.md`](./query.md#민감-컬럼-자동-제거) 참고.

## 문자열 계열 — `CHAR`, `VARCHAR`, `NCHAR`, `NVARCHAR`, `TEXT`, `NTEXT`

JavaScript `string`. `N*` 계열은 UTF-16 인코딩된 유니코드, 나머지는 DB collation의 코드페이지. 드라이버가 UTF-8 문자열로 변환.

`TEXT`·`NTEXT`는 deprecated 타입 — 새 테이블에는 `VARCHAR(MAX)`/`NVARCHAR(MAX)` 사용.

## 정수 — `TINYINT`, `SMALLINT`, `INT`

JavaScript `number` (안전 정수 범위 내).

## `BIGINT`

기본 반환값은 **`number`**. JavaScript `number`는 2^53까지만 정확하게 표현할 수 있어 `BIGINT`(-2^63 ~ 2^63-1)의 안전한 표현이 불가능하므로 큰 값은 정밀도 손실 위험이 있습니다.

풀 옵션에 `parseJSON: true` / `useUTC: false` 같은 옵션은 있지만 BIGINT 문자열화 옵션은 `mssql` 기본 옵션에 없습니다. 정밀도가 필요하면 SQL에서 `CAST(bigint_col AS NVARCHAR)`으로 감싸서 응답을 문자열로 받는 방법이 안전합니다.

## `DECIMAL`, `NUMERIC`, `MONEY`, `SMALLMONEY`

기본 반환값은 **`number`**. `DECIMAL(38, 4)`처럼 큰 정밀도는 IEEE 754로 표현하면 손실이 발생하므로, 정확성이 중요하면 SQL에서 `CAST(dec_col AS NVARCHAR)`로 감싸서 문자열로 받습니다.

MongoDB의 `Decimal128`이나 MySQL/PostgreSQL의 `DECIMAL 자동 문자열화`와 달리 `mssql` 기본은 숫자로 반환한다는 점에 주의.

## `FLOAT`, `REAL`

IEEE 754 부동소수점. JavaScript `number`. 오차가 그대로 노출됩니다.

## `BIT`

JavaScript `boolean` (`0` → `false`, `1` → `true`, `NULL` → `null`).

## `DATE`, `DATETIME`, `DATETIME2`, `SMALLDATETIME`

JavaScript `Date` 객체로 반환. **timezone 정보가 없는 타입**입니다:

- `DATE` — 날짜만.
- `DATETIME` — 밀리초 정밀도의 벽시계 시간(1753~9999년).
- `DATETIME2(n)` — `DATETIME`보다 넓은 범위(0001~9999년)와 더 높은 정밀도(최대 100ns).
- `SMALLDATETIME` — 분 정밀도의 벽시계 시간.

`mssql`은 이 값들을 **UTC로 간주해 `Date`를 조립**합니다 (`options.useUTC` 기본 `true`). DB에 KST 벽시계로 저장돼 있으면 응답 `Date`가 9시간 어긋난 것처럼 보일 수 있습니다.

혼란을 피하려면 **가급적 `DATETIMEOFFSET`을 사용**하거나, 이 컬럼이 어떤 timezone의 벽시계인지 스키마 문서(`tables/*.md`)에 명시합니다.

## `DATETIMEOFFSET`

timezone 오프셋을 함께 저장. JavaScript `Date` 객체로 반환되며 오프셋 파싱을 통해 정확한 순간(instant)으로 변환됩니다 — timezone 관계없이 값이 어긋나지 않으므로 **저장·전송에는 이 타입을 권장**.

## `TIME`

JavaScript `Date` 객체 (`1970-01-01`을 기준으로 시간만 유효). 시간 성분만 필요하면 `Date.prototype.toISOString().slice(11, 19)` 등으로 잘라서 사용.

## `UNIQUEIDENTIFIER`

JavaScript `string` (예: `'6F9619FF-8B86-D011-B42D-00C04FC964FF'`, 대문자).

## `BINARY`, `VARBINARY`, `IMAGE`, `ROWVERSION`, `TIMESTAMP`

Node.js `Buffer`. Express `res.json()`은 `Buffer`를 `{ type: 'Buffer', data: [...] }` 형태로 직렬화하므로 LLM 응답 크기가 커집니다 — 큰 바이너리 컬럼은 SELECT에서 제외하거나 `CONVERT(NVARCHAR, col, 1)`(16진 문자열)로 받는 편이 좋습니다.

> **주의**: SQL Server의 `TIMESTAMP`는 **날짜/시간이 아니라 행 버전(row version) 8바이트 바이너리**입니다. 이름과 달리 datetime 계열이 아니며 `Buffer`로 반환됩니다. 새 컬럼은 명시적으로 `ROWVERSION` 이름을 쓰는 편이 오해가 적습니다.

## `XML`

JavaScript `string` (XML 텍스트). 애플리케이션에서 파싱 필요.

## `SQL_VARIANT`

내부 저장된 실제 타입에 따라 다른 JS 타입으로 반환. 스키마 안정성이 낮으므로 적극적 사용은 지양.

## `GEOGRAPHY`, `GEOMETRY`

CLR 타입. `mssql` 기본 파서는 지원하지 않아 `Buffer`로 반환됩니다. 사용하려면 별도 라이브러리(예: `wkx`)로 파싱하거나, SQL에서 `col.STAsText()`로 WKT 문자열을 뽑는 방식.

## `NULL`

JavaScript `null`.

## 응답 예

```json
{
  "id": 1,
  "email": "user@example.com",
  "big_count": 9007199254740000,
  "amount": 12345.67,
  "created_at": "2024-06-01T09:30:00.000Z",
  "guid": "6F9619FF-8B86-D011-B42D-00C04FC964FF"
}
```

- `big_count`(BIGINT) — 숫자로 반환. 2^53 넘어가면 정밀도 손실.
- `amount`(DECIMAL / MONEY) — 숫자로 반환. 큰 정밀도는 손실 가능.
- `created_at`(DATETIMEOFFSET) — ISO8601 UTC.

## 새 조합 템플릿 만들 때 체크리스트

1. `BIGINT`·`DECIMAL`·`MONEY`가 큰 정밀도로 저장된 컬럼이면 SQL에서 `CAST(col AS NVARCHAR)`로 문자열화 — `mssql` 기본은 정밀도 손실 위험 있는 `number` 반환.
2. `DATETIME`·`DATETIME2`·`SMALLDATETIME`은 timezone 해석 이슈가 있음. 새 컬럼은 `DATETIMEOFFSET` 권장. 기존 컬럼은 어떤 timezone의 벽시계인지 스키마 문서에 명시.
3. `TIMESTAMP` 컬럼은 datetime이 아니라 row version(Buffer)임을 잊지 말 것 — 새 컬럼은 `ROWVERSION` 이름으로.
4. `BINARY`/`VARBINARY`/`IMAGE`가 큰 테이블은 스키마 문서에 명시해 LLM이 `SELECT *`로 뽑지 않도록 안내.
5. `GEOGRAPHY`/`GEOMETRY`가 있는 스키마는 `col.STAsText()` 등으로 WKT 문자열을 SELECT하도록 프롬프트로 유도.
