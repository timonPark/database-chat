# MongoDB Type Conversion

LLM은 필터·프로젝션·파이프라인을 **JSON**으로만 생성할 수 있습니다. MongoDB 고유 타입(`ObjectId`, `Date`, `Decimal128`)은 [MongoDB Extended JSON v2](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/) 형식으로 전달되고, 서버가 요청 처리 직전에 BSON 타입으로 변환합니다.

기준 구현: [`templates/claude-mongodb/server.ts:222`](../../templates/claude-mongodb/server.ts)

## Extended JSON 규약

LLM이 사용하는 형식:

| 대상 타입 | Extended JSON | 예시 |
| --- | --- | --- |
| `ObjectId` | `{"$oid": "<hex24>"}` | `{"userId": {"$oid": "507f1f77bcf86cd799439011"}}` |
| `Date` | `{"$date": "<ISO8601>"}` 또는 `{"$date": {"$numberLong": "<ms>"}}` | `{"createdAt": {"$gte": {"$date": "2024-01-01T00:00:00.000Z"}}}` |
| `Decimal128` | `{"$numberDecimal": "<string>"}` | `{"amount": {"$numberDecimal": "123.45"}}` |

이 형식은 시스템 프롬프트로 LLM에 강제됩니다 (`buildSystemPrompt` 참고).

## 변환 함수 — `convertOid`

이름은 `convertOid`지만 실제로는 `$oid` / `$date` / `$numberDecimal` 세 형태를 모두 처리합니다.

```ts
const OID_REGEX = /^[0-9a-fA-F]{24}$/;

function convertOid(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(convertOid);
  if (obj !== null && typeof obj === 'object') {
    if ('$oid' in obj) return new ObjectId((obj as { $oid: string }).$oid);
    if ('$date' in obj) {
      const value = (obj as { $date: string | { $numberLong: string } }).$date;
      return new Date(typeof value === 'string' ? value : Number(value.$numberLong));
    }
    if ('$numberDecimal' in obj) {
      return Decimal128.fromString((obj as { $numberDecimal: string }).$numberDecimal);
    }
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, convertOid(v)])
    );
  }
  if (typeof obj === 'string' && OID_REGEX.test(obj)) return new ObjectId(obj);
  return obj;
}
```

동작 요약:

- **배열** → 원소별로 재귀.
- **객체**
  - `$oid` 키를 만나면 `new ObjectId(value)`로 치환.
  - `$date` 키를 만나면 문자열은 `new Date(str)`, `{$numberLong}`은 밀리초 숫자로 변환 후 `new Date(ms)`.
  - `$numberDecimal` 키를 만나면 `Decimal128.fromString(value)`로 치환.
  - 그 외 객체는 모든 값에 대해 재귀.
- **문자열이 24자 hex** → `ObjectId`로 자동 승격 (편의성).
- 그 외 값은 그대로 반환.

## 호출 지점

`filter` / `projection` / `pipeline`이 드라이버에 넘어가기 직전에 항상 통과시킵니다.

### `/db-query`

```ts
const convertedFilter = convertOid(filter) as Filter<Document>;
await db.collection(collection).countDocuments(convertedFilter, { maxTimeMS: DB_TIMEOUT_MS });

let cursor = db.collection(collection)
  .find(convertedFilter, { projection: convertOid(projection) as Document })
  .maxTimeMS(DB_TIMEOUT_MS);
```

### `/db-aggregate`

```ts
await db.collection(collection)
  .aggregate(convertOid(countPipeline) as Document[], { maxTimeMS: DB_TIMEOUT_MS })
  .toArray();

await db.collection(collection)
  .aggregate(convertOid(execPipeline) as Document[], { maxTimeMS: DB_TIMEOUT_MS })
  .toArray();
```

## 문자열 자동 승격의 함정

`OID_REGEX`가 24자 hex 문자열을 자동으로 `ObjectId`로 바꾸므로, **정말로 문자열로 저장된 24자 hex 값**을 필터할 때는 다음처럼 명시적으로 감쌉니다:

```json
{ "trackingCode": { "$eq": "abc123def456abc123def456" } }
```

이 값을 문자열 그대로 두고 싶다면 서버가 아닌 프롬프트 규약으로 통제해야 하지만, 현재 구현은 자동 승격을 우선합니다. 필터 결과가 예상과 다르면 이 규칙을 의심하세요.

## 숫자/문자열 이중 저장 필드

전화번호·사번·주민등록번호 등은 컬렉션마다 숫자로도 문자열로도 저장돼 있을 수 있습니다. LLM 프롬프트는 다음 규약을 따릅니다:

- 우선 값 그대로 조회.
- 결과가 0건이면 타입을 반대로 뒤집어 한 번만 재시도. 예) `"01012345678"` → `1012345678` (선행 0 제거된 정수).
- 재시도도 0건이면 "조회된 데이터가 없습니다"로 응답.

이 규약은 프롬프트에만 존재하며 서버는 관여하지 않습니다.

## 새 조합 템플릿 만들 때 체크리스트

1. `filter`, `projection`, `pipeline`을 드라이버에 넘기기 전에 반드시 `convertOid()` 통과.
2. 시스템 프롬프트에 Extended JSON 3종 형식(`$oid`/`$date`/`$numberDecimal`) 예시를 포함.
3. 24자 hex 문자열 자동 승격 규칙은 유지 — 대신 문자열 그대로가 필요한 케이스는 프롬프트로 안내.
4. `Date`는 UTC ISO8601 문자열을 표준 입력으로 삼음 (`Z` 접미사 필수).
