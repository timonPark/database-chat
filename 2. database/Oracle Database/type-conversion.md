# Oracle Type Conversion

`oracledb`(node-oracledb) 드라이버가 Oracle 컬럼 값을 JavaScript로 변환하는 규칙을 정리합니다. 서버 측에서 별도 캐스팅 로직은 두지 않고 드라이버 기본 동작에 의존합니다 — 응답의 값 형태(문자열/숫자/Date)를 예측하려면 이 문서를 참고하세요.

기준 구현: [`templates/claude-oracle/server.ts:380`](../../templates/claude-oracle/server.ts) (`execute()` 옵션)

## 컬럼명 대문자 반환

Oracle의 데이터 딕셔너리는 컬럼명을 기본 대문자로 저장하므로, `SELECT id, name FROM users` 결과의 응답 키는 **`ID`, `NAME`**입니다. 원본 대소문자 유지가 필요하면 SQL에서 큰따옴표로 감싸야 합니다:

```sql
SELECT "id", "name" FROM users;   -- 응답 키: id, name
```

기본 규약은 대문자 그대로 두는 것.

## 문자열 계열 — `VARCHAR2`, `NVARCHAR2`, `CHAR`, `NCHAR`

JavaScript `string`. 인코딩은 DB의 `NLS_CHARACTERSET` (통상 `AL32UTF8`)을 따르며 드라이버가 UTF-8로 변환.

## `CLOB`, `NCLOB`

기본 반환값은 `oracledb.Lob` 스트림 객체. 그대로 `res.json()`으로 직렬화하면 빈 객체가 나오므로, **작은 CLOB이면 `fetchAsString`으로 문자열 변환을 요청**하는 옵션이 필요합니다:

```ts
oracledb.fetchAsString = [oracledb.CLOB];   // 모듈 초기화 1회
// 또는 execute 옵션에서 컬럼별 지정
```

기본 템플릿은 이 설정을 건드리지 않습니다 — CLOB 컬럼이 있으면 명시적으로 `TO_CHAR(clob_col)`을 SELECT에서 사용하거나 조합 템플릿에서 위 옵션을 추가해야 합니다. 무설정 상태로 CLOB을 SELECT하면 응답에 `Lob` 객체가 실려 프런트에서 활용 불가.

## 숫자 — `NUMBER`, `NUMBER(p, s)`, `INTEGER`, `FLOAT`, `BINARY_FLOAT`, `BINARY_DOUBLE`

기본 반환값은 JavaScript `number`. Oracle `NUMBER`는 임의 정밀도이므로 이론적으로는 문자열로 받아야 정확하지만, 기본 템플릿은 `number`로 받습니다 — 2^53(약 9,007조)을 넘는 정수나 소수점 이하 정밀도가 중요한 값이면 손실이 발생할 수 있습니다.

정밀도가 필요하면 `fetchAsString = [oracledb.NUMBER]`로 문자열 반환을 강제하거나, SQL에서 `TO_CHAR(num_col)`으로 캐스팅합니다.

`BINARY_FLOAT`·`BINARY_DOUBLE`은 IEEE 754 부동소수점 — JavaScript `number`와 동일 표현이라 오차 없이 왕복.

## `DATE`

Oracle `DATE`는 초 단위 정밀도(연·월·일·시·분·초)까지만 저장하고 timezone 정보가 없습니다. 드라이버는 이 값을 JavaScript `Date` 객체로 반환합니다.

**`oracledb.fetchAsString = [oracledb.DATE]` 미설정 기본 동작**은 `Date` 객체 — JSON 직렬화 시 ISO8601로 나가지만 timezone 처리에 주의가 필요합니다. 세션 timezone에 따라 벽시계 값이 달리 해석될 수 있습니다.

## `TIMESTAMP`

밀리초까지의 정밀도(정확히는 소수점 이하 최대 9자리)를 저장. `Date` 객체로 반환. `DATE`와 마찬가지로 timezone 정보가 없으므로 세션 timezone 해석 이슈가 있습니다.

## `TIMESTAMP WITH TIME ZONE`, `TIMESTAMP WITH LOCAL TIME ZONE`

timezone 정보를 함께 저장. `Date` 객체로 반환되며 timezone 오프셋이 정확히 반영됩니다 — timezone 관계없이 값이 어긋나지 않으므로 **저장·전송에는 이 타입을 권장**.

## `RAW(N)`, `LONG RAW`

Node.js `Buffer`. Express `res.json()`은 `Buffer`를 `{ type: 'Buffer', data: [...] }` 형태로 직렬화하므로 LLM 응답 크기가 커집니다 — 큰 바이너리 컬럼은 SELECT에서 제외하거나 `RAWTOHEX(col)`로 문자열화해서 받는 편이 좋습니다.

## `BLOB`

기본 반환값은 `oracledb.Lob` 스트림 객체. CLOB과 마찬가지로 직렬화가 되지 않으므로 `fetchAsBuffer = [oracledb.BLOB]`으로 `Buffer` 변환을 지정하거나 별도 스트림 처리 필요. 기본 템플릿은 이 설정을 건드리지 않습니다 — BLOB 컬럼은 SELECT에서 제외 권장.

## `JSON` (Oracle 21c+ 네이티브 JSON)

Oracle 21c 이상의 네이티브 `JSON` 타입은 드라이버가 자동으로 JavaScript 객체/배열로 파싱합니다. 별도 `JSON.parse` 불필요.

Oracle 19c 이하에서 `VARCHAR2`/`CLOB`에 JSON 문자열로 저장한 경우엔 문자열 그대로 반환되므로 애플리케이션에서 `JSON.parse` 필요.

## `INTERVAL YEAR TO MONTH`, `INTERVAL DAY TO SECOND`

기본 반환값은 **문자열** (Oracle 형식 그대로 — `+000000001-02` 같은 표기). JS 객체로는 자동 매핑되지 않습니다. 프런트에서 파싱해서 표시하거나, SQL에서 `EXTRACT`로 필요한 성분만 추출해서 응답에 담는 방식을 권장.

## `NULL`

JavaScript `null`.

## 응답 예

```json
{
  "ID": 1,
  "EMAIL": "user@example.com",
  "AMOUNT": 12345.67,
  "CREATED_AT": "2024-06-01T09:30:00.000Z",
  "META": { "channel": "web" },
  "DURATION": "+000000001 02:00:00.000000"
}
```

- 컬럼명 대문자.
- `AMOUNT`(NUMBER) — 숫자로 반환됨. 큰 값은 정밀도 손실 위험.
- `CREATED_AT`(TIMESTAMP WITH TIME ZONE) — ISO8601 UTC.
- `META`(JSON, Oracle 21c+) — 자동 파싱.
- `DURATION`(INTERVAL) — 문자열.

## 새 조합 템플릿 만들 때 체크리스트

1. `NUMBER`가 정밀도가 중요한 컬럼이면 `oracledb.fetchAsString = [oracledb.NUMBER]` 설정 또는 SQL에서 `TO_CHAR` 사용.
2. `CLOB`/`BLOB` 컬럼이 있는 스키마는 스키마 문서(`tables/*.md`)에 명시. 사용하려면 `fetchAsString`/`fetchAsBuffer` 옵션을 명시적으로 활성화하거나 SELECT에서 제외.
3. `DATE`/`TIMESTAMP`(WITHOUT TIME ZONE)는 timezone 해석 이슈가 있음. 새 컬럼은 `TIMESTAMP WITH TIME ZONE` 권장.
4. `INTERVAL`은 문자열 형태로 응답에 실림 — 프런트엔드에서 표시 규약을 별도로 정할 것.
5. 응답 컬럼명이 기본 대문자임을 프런트/응답 규약에 반영. 원본 대소문자 유지가 필요하면 SQL에서 `"컬럼명"` 인용.
