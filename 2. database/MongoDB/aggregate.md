# MongoDB Aggregate — `/db-aggregate`

집계 파이프라인 실행 엔드포인트. `$group`·`$lookup`·`$unwind`·계산 필드가 필요할 때 사용합니다. 단순 필터·정렬·프로젝션만 필요하면 [`/db-query`](./query.md)를 씁니다.

기준 구현: [`templates/claude-mongodb/server.ts:539`](../../templates/claude-mongodb/server.ts)

## 요청 스펙

`POST /db-aggregate`

```json
{
  "requestId": "req-abc-123",
  "database": "myapp",
  "collection": "orders",
  "pipeline": [
    { "$match": { "status": "paid" } },
    { "$lookup": { "from": "users", "localField": "userId", "foreignField": "_id", "as": "user" } },
    { "$unwind": "$user" },
    { "$group": { "_id": "$user._id", "userDoc": { "$first": "$user" }, "total": { "$sum": "$amount" } } },
    { "$limit": 20 }
  ],
  "limit": 20
}
```

| 필드 | 타입 | 필수 | 기본값 |
| --- | --- | --- | --- |
| `requestId` | string | | — |
| `database` | string | | `DB_DATABASE` (.env) |
| `collection` | string | ✅ | — |
| `pipeline` | array | ✅ | — |
| `limit` | number | | `20` (자동 `$limit` 주입 시 사용) |

`collection` 누락 또는 `pipeline`이 비어 있으면 400 반환.

## 파이프라인 보안 검증

파이프라인의 모든 stage를 재귀적으로 스캔하여 쓰기 stage를 차단합니다.

```ts
const BLOCKED_AGGREGATION_STAGES = new Set(['$out', '$merge']);

function assertReadOnlyPipeline(pipeline: Document[]): void {
  for (const stage of pipeline) {
    const name = Object.keys(stage)[0];
    if (name && BLOCKED_AGGREGATION_STAGES.has(name)) {
      throw new Error(`${name} 단계는 읽기 전용 조회에서 사용할 수 없습니다.`);
    }
    if ('$lookup' in stage) {
      const lookup = stage.$lookup as { pipeline?: Document[] };
      if (Array.isArray(lookup.pipeline)) assertReadOnlyPipeline(lookup.pipeline);
    }
    if ('$facet' in stage) {
      for (const nested of Object.values(stage.$facet as Record<string, Document[]>)) {
        if (Array.isArray(nested)) assertReadOnlyPipeline(nested);
      }
    }
    if ('$unionWith' in stage) {
      const unionWith = stage.$unionWith as { pipeline?: Document[] };
      if (Array.isArray(unionWith.pipeline)) assertReadOnlyPipeline(unionWith.pipeline);
    }
  }
}
```

`$lookup.pipeline`, `$facet.*`, `$unionWith.pipeline`처럼 하위에 파이프라인을 품는 stage도 모두 재귀 검사합니다. 검증 실패 시 500 + 에러 메시지 반환.

## 민감 필드 자동 제거

파이프라인 실행 직전에 `$unset` stage를 부착해 결과에서 민감 필드를 지웁니다.

```ts
const SENSITIVE_FIELDS = ['password', 'passHash'];

function withSensitiveFieldsUnset(pipeline: Document[]): Document[] {
  return [...pipeline, { $unset: SENSITIVE_FIELDS }];
}
```

LLM이 `$project`로 어떤 형태의 결과를 뽑든 마지막에 `$unset: ['password', 'passHash']`가 실행됩니다.

## 자동 `$limit` 주입

파이프라인 끝(=마지막 non-project stage)에 `$limit`이 없으면 서버가 강제로 `{ $limit: <limit> }`를 부착합니다. LLM tool 출력 한도(약 8KB) 초과를 방지하기 위함.

```ts
const lastNonProject = [...pipelineArr].reverse().find(s => !('$project' in s));
const hadTerminalLimit = lastNonProject != null && '$limit' in lastNonProject;
const effectivePipeline = hadTerminalLimit
  ? pipelineArr
  : [...pipelineArr, { $limit: limit }];
const autoLimited = !hadTerminalLimit;
```

자동 주입이 일어난 경우 응답에 다음이 붙습니다:

```json
{
  "count": 8421,
  "data": [ ... ],
  "autoLimitedTo": 20,
  "message": "pipeline 끝에 $limit 이 없어 서버가 자동으로 { $limit: 20 } 을 부착했습니다. ..."
}
```

LLM은 `autoLimitedTo`가 보이면 **재쿼리 없이** 반환된 상위 N건으로 사용자에게 응답해야 합니다 (프롬프트에도 이 규약을 명시).

## 총 건수 계산 — `pipelineForCount`

`count`는 "터미널 `$limit`을 뺀 파이프라인"에 `{ $count: 'total' }`을 붙여 계산합니다.

```ts
function pipelineForCount(pipeline: Document[]): Document[] {
  let lastNonProjectIndex = -1;
  for (let i = pipeline.length - 1; i >= 0; i -= 1) {
    if (!isPresentationStage(pipeline[i])) { lastNonProjectIndex = i; break; }
  }
  const lastNonProject = lastNonProjectIndex >= 0 ? pipeline[lastNonProjectIndex] : undefined;
  const isTerminalLimit = lastNonProject != null && '$limit' in lastNonProject;
  if (!isTerminalLimit) return pipeline;
  return pipeline.slice(0, lastNonProjectIndex);
}

const countPipeline = [ ...pipelineForCount(effectivePipeline), { $count: 'total' } ];
```

이렇게 하면 사용자가 본 `data`(상위 N건)와 별개로 실제 매칭된 총 건수를 정확히 리턴할 수 있습니다.

`isPresentationStage`는 `$project`·`$unset`만 표시용으로 취급합니다 — 이런 stage는 카운트에 영향을 주지 않기 때문.

## 병렬 실행

`count`와 `data`는 `Promise.all`로 병렬 실행합니다:

```ts
const [countResult, docsResult] = await Promise.all([
  db.collection(collection).aggregate(convertOid(countPipeline), { maxTimeMS: DB_TIMEOUT_MS }).toArray(),
  db.collection(collection).aggregate(convertOid(execPipeline),   { maxTimeMS: DB_TIMEOUT_MS }).toArray(),
]);
const totalCount = countResult[0]?.total ?? docsResult.length;
```

## 응답 스펙

정상 (자동 주입 없음):

```json
{ "count": 42, "data": [ ... ], "dbTimeMs": 87 }
```

정상 (자동 `$limit` 주입):

```json
{
  "count": 8421,
  "data": [ ... ],
  "dbTimeMs": 156,
  "autoLimitedTo": 20,
  "message": "pipeline 끝에 $limit 이 없어 서버가 자동으로 { $limit: 20 } 을 부착했습니다. ..."
}
```

0건:

```json
{
  "count": 0,
  "data": [],
  "dbTimeMs": 12,
  "message": "조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라."
}
```

## 응답 크기 자동 축약 — `capForToolOutput`

LLM tool 출력 한도(약 8KB, 여유 마진 포함 6500B)를 초과하면 상위 몇 건만 잘라서 보냅니다.

```ts
const TOOL_OUTPUT_MAX_BYTES = 6500;

function capForToolOutput(body: Record<string, unknown>): Record<string, unknown> {
  const data = body.data;
  if (!Array.isArray(data) || data.length === 0) return body;
  // wrapper 오버헤드부터 계산 후 원소를 하나씩 넣어보며 한도 안에서 최대 몇 건까지 담기는지 계산
  ...
  return {
    ...body,
    data: data.slice(0, kept),
    truncatedTo: kept,
    truncatedFrom: originalCount,
    hint: `LLM tool 출력 한도(약 8KB) 대응: 요청한 ${originalCount}건 중 상위 ${kept}건만 전송. ...`,
  };
}
```

- `truncatedTo`, `truncatedFrom`, `hint`가 응답에 붙습니다.
- LLM은 이 세 필드가 보이면 **재쿼리·python/wc 우회·재시도 금지**, 반환된 데이터 그대로 사용자에게 응답해야 합니다.
- 필드/건수를 더 줄이고 싶으면 다음 요청에서 `$project`로 필드를 줄이거나 `limit`을 낮춰 재요청합니다.

## 엑셀 내보내기 재실행

`requestId`가 오면 **원본(주입 전) pipeline**을 저장합니다. `POST /db-export`가 호출되면:

```ts
const exportPipeline = withSensitiveFieldsUnset(pipelineWithoutTerminalLimit(pipeline));
```

- 터미널 `$limit`만 제거 — `$project`는 보존해 UI에서 사용자가 본 컬럼 구성과 내보내기 컬럼 구성을 일치시킵니다.
- 민감 필드 `$unset`은 여전히 부착.

## `$lookup` 관례

집계에서 `$lookup`을 쓸 때 서버 코드가 강제하지 않는 관례 (프롬프트에서 규정):

- `$lookup` 대상은 **같은 database**의 컬렉션만 가능. 크로스 DB 조인 불가.
- `$lookup` + `$unwind` 이후에는 반드시 `$group`으로 중복을 제거 (1:N 조인 시 중복 발생).
- `foreignField` 타입(ObjectId/Number/String)이 `localField`와 일치하는지 확인 후 파이프라인 조립.
- `$group`에서 조인 대상 필드는 `$first: "$user"`로 전체 문서를 수집한 뒤 `$replaceRoot`로 루트를 교체 — 필드를 개별 나열하지 말 것.

## 새 조합 템플릿 만들 때 체크리스트

1. `assertReadOnlyPipeline()`을 파이프라인 실행 전에 반드시 호출.
2. `withSensitiveFieldsUnset()`으로 실행 파이프라인에 `$unset` 부착.
3. 자동 `$limit` 주입 규칙 유지 — 응답에 `autoLimitedTo`를 노출해 LLM이 재쿼리하지 않게 함.
4. `pipelineForCount()`로 카운트용 파이프라인을 분리해 정확한 총 건수를 계산.
5. `queryParamsStore`에는 **원본** pipeline(주입 전)을 저장 — 엑셀 내보내기 재실행 시 사용자가 본 결과와 형태가 일치해야 함.
6. 응답 body는 반드시 `capForToolOutput()`을 통과시켜 반환.
