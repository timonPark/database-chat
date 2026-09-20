# MongoDB Query — `/db-query`

단일 컬렉션 조회 엔드포인트. `find` 기반의 필터·프로젝션·정렬·limit만 다룹니다. `$group`, `$lookup`, 계산 필드가 필요하면 [`/db-aggregate`](./aggregate.md)를 씁니다.

기준 구현: [`templates/claude-mongodb/server.ts:483`](../../templates/claude-mongodb/server.ts)

## 요청 스펙

`POST /db-query`

```json
{
  "requestId": "req-abc-123",
  "database": "myapp",
  "collection": "users",
  "filter": { "status": "active" },
  "projection": { "name": 1, "email": 1 },
  "sort": { "createdAt": -1 },
  "limit": 20
}
```

| 필드 | 타입 | 필수 | 기본값 |
| --- | --- | --- | --- |
| `requestId` | string | | — (엑셀 내보내기용 쿼리 저장 키) |
| `database` | string | | `DB_DATABASE` (.env) |
| `collection` | string | ✅ | — |
| `filter` | object | | `{}` |
| `projection` | object | | `{}` |
| `sort` | object | | — |
| `limit` | number | | `20` |

`collection`이 없으면 400 반환.

## 실행 흐름 (2단계)

전체 건수(`totalCount`)와 상위 `limit`건 데이터를 각각 조회해서 함께 응답합니다.

```ts
// Step 1: 전체 건수
const totalCount = await db.collection(collection)
  .countDocuments(convertedFilter, { maxTimeMS: DB_TIMEOUT_MS });

if (totalCount === 0) {
  return res.json({ count: 0, data: [], dbTimeMs,
    message: '조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라.' });
}

// Step 2: 상위 limit건
let cursor = db.collection(collection)
  .find(convertedFilter, { projection: convertOid(projection) })
  .maxTimeMS(DB_TIMEOUT_MS);
if (sort) cursor = cursor.sort(sort);
const docs = await cursor.limit(limit).toArray();
```

- **`count`는 총 건수**, **`data`는 상위 limit건**이라는 응답 계약을 지킵니다. LLM 프롬프트도 이 규약에 맞춰 작성.
- 0건이면 짧은 지시 문구를 `message`에 실어 반환 — LLM이 반복 쿼리하는 것을 방지합니다.

## 응답 스펙

정상:

```json
{
  "count": 137,
  "data": [ { "_id": "...", "name": "..." }, ... ],
  "dbTimeMs": 42
}
```

0건:

```json
{
  "count": 0,
  "data": [],
  "dbTimeMs": 5,
  "message": "조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라."
}
```

타임아웃 (30초 초과):

```
HTTP/1.1 504 Gateway Timeout
{ "error": "DB 응답시간 초과 Max 30초" }
```

기타 오류: HTTP 500 + `{ "error": "..." }`.

## 민감 필드 자동 제거

`projection`이 어떤 형태든 `password`·`passHash`는 응답에서 제외됩니다.

```ts
function applyProjectionSecurity(projection: Projection): void {
  const isInclusion = Object.values(projection).some(v => v === 1 || v === true);
  if (isInclusion) {
    delete projection.passHash;
    delete projection.password;
  } else {
    projection.passHash = 0;
    projection.password = 0;
  }
}
```

- **inclusion projection**(`{ name: 1 }`)이면 민감 키를 목록에서 제거.
- **exclusion projection**(`{ largeField: 0 }` 또는 빈 객체)이면 민감 키를 exclusion으로 추가.

이 함수는 요청 처리 초반에 1회 호출됩니다.

## 응답 크기 자동 축약

LLM tool 출력 한도(약 8KB)를 초과할 것 같으면 상위 몇 건만 잘라 보냅니다. 자세한 규칙은 [`aggregate.md`](./aggregate.md#응답-크기-자동-축약)와 동일 — `capForToolOutput()` 유틸을 공유합니다.

응답에 `truncatedTo` 필드가 붙으면 LLM은 재쿼리하지 말고 잘린 결과 그대로 사용자에게 응답해야 합니다.

## Extended JSON 필터

`filter`/`projection`에 오는 `{"$oid": "..."}`, `{"$date": "..."}`, `{"$numberDecimal": "..."}`는 서버가 BSON 타입으로 변환한 뒤 드라이버에 넘깁니다. 규칙은 [`type-conversion.md`](./type-conversion.md) 참고.

## `requestId`와 엑셀 내보내기

`requestId`가 오면 쿼리 파라미터를 `queryParamsStore` (`Map<string, QueryParams>`)에 저장합니다. `POST /db-export`가 같은 `requestId`로 호출되면 저장된 파라미터로 **limit 없이** 재실행해 전체 결과를 반환합니다.

```ts
const qParams = { database: targetDb, collection, filter, projection, sort };
if (requestId && collection) queryParamsStore.set(requestId, qParams);
queryParamsStore.set('__latest__', qParams);
```

`__latest__` 폴백 키는 `requestId`를 잃어버린 클라이언트가 마지막 쿼리를 내보낼 수 있게 하는 안전망입니다.

## 새 조합 템플릿 만들 때 체크리스트

1. `collection` 유효성 검사(400) 유지.
2. 2단계 실행(count → data) 순서와 응답 계약(`count` = 총 건수) 준수.
3. `applyProjectionSecurity` 호출 지점을 옮기지 말 것 — 캐싱된 `qParams`가 민감 필드 exclusion을 이미 반영해야 엑셀 내보내기도 안전합니다.
4. 모든 커서 호출에 `maxTimeMS: DB_TIMEOUT_MS`를 붙일 것.
5. 응답 body는 반드시 `capForToolOutput()`을 통과시켜 반환.
