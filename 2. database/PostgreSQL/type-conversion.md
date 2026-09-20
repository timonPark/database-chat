# PostgreSQL Type Conversion

`pg` (node-postgres) 드라이버가 PostgreSQL 컬럼 값을 JavaScript로 변환하는 규칙을 정리합니다. 서버 측에서 별도 캐스팅 로직은 두지 않고 드라이버 기본 동작(`pg-types`)에 의존합니다 — 응답의 값 형태(문자열/숫자/Date)를 예측하려면 이 문서를 참고하세요.

기준 구현: [`templates/claude-postgresql/server.ts:178`](../../templates/claude-postgresql/server.ts) (풀 옵션)

## 문자열 계열 — `TEXT`, `VARCHAR`, `CHAR`, `NAME`

JavaScript `string`. 인코딩은 DB의 `server_encoding`을 따르며 통상 `UTF8`.

## 정수 — `SMALLINT` (int2), `INTEGER` (int4)

JavaScript `number` (안전 정수 범위 내).

## `BIGINT` (int8)

기본 반환값은 **`string`**. JavaScript `number`는 2^53까지만 정확하게 표현할 수 있어 `BIGINT`(-2^63 ~ 2^63-1)의 안전한 표현이 불가능하기 때문. 산술 연산이 필요하면 `Number(...)` 또는 `BigInt(...)`로 변환해야 합니다.

`pg-types`의 `setTypeParser(20, val => parseInt(val, 10))`로 강제 숫자화할 수도 있지만 **기본 템플릿은 이 설정을 건드리지 않습니다** — LLM 응답에 `BIGINT` 값이 문자열로 노출된다는 사실만 알고 있으면 됩니다.

## `NUMERIC`, `DECIMAL`

기본 반환값은 **`string`**. 부동소수점 오차 없는 정확한 값을 보존하기 위함. 산술이 필요하면 `Number(...)` 또는 `decimal.js` 같은 라이브러리로 변환.

## `REAL` (float4), `DOUBLE PRECISION` (float8)

JavaScript `number`. IEEE 754 오차가 그대로 노출됩니다.

## `BOOLEAN`

JavaScript `boolean`.

## `DATE`

JavaScript `Date` 객체. 시간 부분은 로컬 timezone의 `00:00:00`으로 조립되므로 JSON 직렬화 시 timezone에 따라 하루가 밀린 값처럼 보일 수 있습니다.

## `TIMESTAMP` (timestamp without time zone)

JavaScript `Date` 객체. timezone 정보가 없는 값을 `pg`가 **로컬 timezone의 벽시계 시간**으로 간주해 `Date`를 조립합니다. DB에 UTC로 저장돼 있고 앱 서버가 KST에서 돌면 값이 9시간 어긋난 것처럼 보일 수 있습니다.

혼란을 피하려면 **가급적 `TIMESTAMPTZ`를 사용**하거나, 이 컬럼이 어떤 timezone의 벽시계인지 스키마 문서(`tables/*.md`)에 명시합니다.

## `TIMESTAMPTZ` (timestamp with time zone)

JavaScript `Date` 객체. PostgreSQL은 내부적으로 UTC로 저장하고 세션 timezone에 맞춰 반환하는데, `pg`는 timezone 오프셋을 파싱해 정확한 순간(instant)의 `Date`를 만듭니다. Timezone 관계없이 값이 어긋나지 않으므로 **저장·전송에는 이 타입을 권장**.

## `TIME`, `TIMETZ`

JavaScript `string` (`'HH:MM:SS'` 형태). `Date`가 아닙니다.

## `INTERVAL`

JavaScript **객체** — 예: `{ years: 1, months: 2, days: 3, hours: 4, minutes: 5, seconds: 6 }`. `postgres-interval` 라이브러리가 파싱합니다. JSON 직렬화 시 그대로 객체 형태로 응답에 실립니다.

## `JSON`, `JSONB`

`pg`는 두 타입 모두 자동으로 파싱해 JavaScript 객체/배열로 반환합니다. 별도 `JSON.parse` 불필요.

## `UUID`

JavaScript `string` (예: `'123e4567-e89b-12d3-a456-426614174000'`).

## `BYTEA`

Node.js `Buffer` 객체로 반환됩니다. Express `res.json()`은 `Buffer`를 `{ type: 'Buffer', data: [...] }` 형태로 직렬화하므로 LLM 응답 크기가 커집니다 — 큰 바이너리 컬럼은 SELECT에서 제외하거나 `encode(col, 'hex')`로 문자열화해서 받는 편이 좋습니다.

## 배열 (`INTEGER[]`, `TEXT[]`, `JSONB[]` 등)

JavaScript `Array`. `pg`가 PostgreSQL 배열 리터럴을 파싱해 JS 배열로 조립합니다. 원소 타입은 위 규칙을 그대로 따릅니다 — 예: `INTEGER[]` → `number[]`, `NUMERIC[]` → `string[]`.

다차원 배열(`INTEGER[][]`)은 중첩 JS 배열로 반환.

## `INET`, `CIDR`, `MACADDR`

JavaScript `string`.

## enum 타입

사용자 정의 enum은 JavaScript `string` (enum label 그대로).

## composite / range / custom 타입

기본 파서가 없는 커스텀 타입은 원본 문자열 그대로 반환됩니다. 필요하면 `pg-types.setTypeParser`로 개별 등록해야 하지만 기본 템플릿은 등록하지 않습니다.

## `NULL`

JavaScript `null`.

## 응답 예

```json
{
  "id": 1,
  "email": "user@example.com",
  "big_count": "9223372036854775000",
  "amount": "123.45",
  "rate": 0.19999999999999998,
  "created_at": "2024-06-01T00:00:00.000Z",
  "meta": { "channel": "web" },
  "tags": ["signup", "trial"],
  "duration": { "hours": 1, "minutes": 30 }
}
```

- `big_count`(BIGINT), `amount`(NUMERIC) — 문자열.
- `rate`(DOUBLE) — 숫자, 부동소수점 오차 노출.
- `created_at`(TIMESTAMPTZ) — ISO8601 UTC.
- `meta`(JSONB), `tags`(TEXT[]) — 자동 파싱.
- `duration`(INTERVAL) — 객체.

## 새 조합 템플릿 만들 때 체크리스트

1. `BIGINT`, `NUMERIC`, `DECIMAL`은 문자열로 반환된다는 점을 프론트/LLM 응답 규약에 반영.
2. `TIMESTAMP` (timezone 없음) vs `TIMESTAMPTZ` (timezone 포함) 구분을 스키마 문서에 명시. 새 컬럼은 `TIMESTAMPTZ` 권장.
3. `BYTEA` 컬럼이 큰 테이블은 스키마 문서(`tables/*.md`)에 명시해 LLM이 `SELECT *`로 뽑지 않도록 안내.
4. `INTERVAL`은 객체 형태로 응답에 실림 — 프런트엔드에서 표시 규약을 별도로 정할 것.
5. 커스텀 타입(composite/range/enum 확장)은 필요 시 `pg-types.setTypeParser`로 파서 등록.
