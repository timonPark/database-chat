# MySQL Type Conversion

`mysql2/promise` 드라이버가 MySQL 컬럼 값을 JavaScript로 변환하는 규칙을 정리합니다. 서버 측에서 별도 캐스팅 로직은 두지 않고 드라이버 기본 동작에 의존합니다 — 응답의 값 형태(문자열/숫자/Date)를 예측하려면 이 문서를 참고하세요.

기준 구현: [`templates/claude-mysql/server.ts:31`](../../templates/claude-mysql/server.ts) (풀 옵션)

## 문자열 계열 — `CHAR`, `VARCHAR`, `TEXT`, `ENUM`, `SET`

JavaScript `string`. 인코딩은 커넥션 charset을 따르며 기본은 `utf8mb4`.

## 정수 — `TINYINT`, `SMALLINT`, `MEDIUMINT`, `INT`

JavaScript `number` (안전 정수 범위 내).

## `BIGINT`

기본 반환값은 **`string`**. JavaScript `number`는 2^53까지만 정확하게 표현할 수 있어 `BIGINT`(-2^63 ~ 2^63-1)의 안전한 표현이 불가능하기 때문. 산술 연산이 필요하면 `Number(...)` 또는 `BigInt(...)`로 변환해야 합니다.

풀 옵션에서 `bigNumberStrings: false`, `supportBigNumbers: true`로 바꾸면 다르게 동작하지만 **기본 템플릿은 이 설정을 건드리지 않습니다** — LLM 응답에 `BIGINT` 값이 문자열로 노출된다는 사실만 알고 있으면 됩니다.

## `DECIMAL`, `NUMERIC`, `FLOAT`, `DOUBLE`

`DECIMAL`·`NUMERIC`은 기본 반환값이 **`string`**. 부동소수점 오차 없는 정확한 값을 보존하기 위함. 산술이 필요하면 `Number(...)` 또는 `decimal.js` 같은 라이브러리로 변환.

`FLOAT`·`DOUBLE`은 JavaScript `number`로 반환됩니다. IEEE 754 오차가 그대로 노출됩니다.

응답 예:

```json
{ "amount": "123.45", "rate": 0.19999999999999998 }
```

## `DATE`, `DATETIME`, `TIMESTAMP`

JavaScript `Date` 객체로 반환됩니다 (JSON 직렬화 시 ISO8601 문자열).

풀 옵션 `timezone: '+00:00'` (UTC)이 설정돼 있어:

- **`TIMESTAMP`** — MySQL이 저장할 때 세션 timezone에서 UTC로 변환해 저장하고, 조회 시 세션 timezone으로 되돌립니다. 드라이버가 UTC로 세션을 열면 저장된 UTC 값 그대로 반환.
- **`DATETIME`** — timezone 정보가 없는 벽시계 시간. 드라이버가 "이 값이 어떤 timezone의 시각인가"를 풀 옵션의 timezone(`+00:00`)으로 간주하여 `Date`를 조립합니다. **DB에 KST(+09:00) 벽시계로 저장돼 있다면 이 옵션 값이 실제 timezone과 다르므로 응답 시각이 9시간 어긋납니다.**

DB의 실제 timezone과 다르게 저장돼 있으면 `timezone: '+09:00'` 등으로 조정하거나, 애플리케이션 레벨에서 오프셋 보정이 필요합니다.

`DATE`는 시간 부분이 없이 `YYYY-MM-DD 00:00:00` UTC로 조립된 `Date`가 반환됩니다.

## `TIME`

JavaScript `string` (`'HH:MM:SS'` 형태). `Date` 객체가 아닙니다.

## `YEAR`

JavaScript `number` (예: `2026`).

## `JSON`

`mysql2`는 `JSON` 컬럼을 자동으로 파싱해 JavaScript 객체/배열로 반환합니다. 별도 `JSON.parse` 불필요.

## `BINARY`, `VARBINARY`, `BLOB`, `TINYBLOB`, `MEDIUMBLOB`, `LONGBLOB`

Node.js `Buffer` 객체로 반환됩니다. Express `res.json()`은 `Buffer`를 `{ type: 'Buffer', data: [...] }` 형태로 직렬화하므로 LLM 응답 크기가 커집니다 — 큰 바이너리 컬럼은 SELECT에서 제외하거나 `HEX(col)`로 감싸서 문자열로 받는 편이 좋습니다.

## `BIT(N)`

`Buffer` 객체로 반환됩니다. 정수로 다루려면 `buf.readUIntBE(0, buf.length)` 등을 사용.

## `NULL`

JavaScript `null`.

## LLM 프롬프트가 다루는 이중 저장 필드

전화번호·사번·주민등록번호 등은 컬럼 정의(`VARCHAR` vs `BIGINT`)에 따라 다르게 저장돼 있을 수 있습니다. 시스템 프롬프트는 다음 규약을 따릅니다:

- 우선 값 그대로 조회 — 예: `WHERE phone = '01012345678'`.
- 결과가 0건이면 타입을 반대로 뒤집어 한 번만 재시도. 예: `WHERE phone = 01012345678` 또는 `WHERE CAST(phone AS UNSIGNED) = 01012345678`.
- 재시도도 0건이면 "조회된 데이터가 없습니다".

이 규약은 프롬프트에만 존재하며 서버는 관여하지 않습니다.

## 새 조합 템플릿 만들 때 체크리스트

1. 풀 옵션 `timezone: '+00:00'` 유지. DB timezone과 어긋나면 이 값을 먼저 조정.
2. `BIGINT`, `DECIMAL`, `NUMERIC`은 문자열로 반환된다는 점을 프론트/LLM 응답 규약에 반영.
3. `BLOB`/`BINARY` 컬럼이 큰 테이블은 스키마 문서(`tables/*.md`)에 명시해 LLM이 `SELECT *`로 뽑지 않도록 안내.
4. `DATE`/`DATETIME` 응답이 KST로 표시되어야 한다면 응답 직렬화 단계 또는 프런트엔드에서 오프셋 처리.
