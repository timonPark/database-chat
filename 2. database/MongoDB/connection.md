# MongoDB Connection

MongoDB 노드 드라이버로 `MongoClient`를 생성해 애플리케이션 수명 동안 재사용합니다. 요청마다 새 연결을 열지 않고, 드라이버 내장 커넥션 풀에 의존합니다.

## 환경 변수

기준 구현: [`templates/claude-mongodb/server.ts:11`](../../templates/claude-mongodb/server.ts)

| 변수 | 기본값 | 필수 |
| --- | --- | --- |
| `DB_HOST` | — | ✅ |
| `DB_PORT` | `27017` | |
| `DB_DATABASE` | — | ✅ |
| `DB_USER_NAME` | — | ✅ |
| `DB_USER_PASSWORD` | — | ✅ |

필수 4종(`DB_HOST`, `DB_DATABASE`, `DB_USER_NAME`, `DB_USER_PASSWORD`) 중 하나라도 없으면 서버는 즉시 `process.exit(1)`로 종료합니다.

## 계정 권한 (Role)

`DB_USER_NAME` 계정은 대상 DB에 대해 **스키마(컬렉션 메타데이터)와 데이터를 모두 읽을 수 있는 권한**이 있어야 합니다. 이 권한이 없으면:

- 서버 런타임의 `find`·`aggregate`·`countDocuments` 호출이 실패합니다.
- `seeds/mongodb/`의 스키마 생성 파이프라인이 `listCollections`·`listIndexes`를 호출하지 못해 컬렉션 인덱스와 필드 스키마 파일을 만들 수 없습니다.

MongoDB 내장 역할 기준 최소 요구치는 대상 DB에 대한 **`read`** 역할입니다. `read`는 다음을 포함합니다:

- 데이터 조회: `find`
- 스키마 조회: `listCollections`, `listIndexes`
- 통계: `collStats`, `dbStats`, `dbHash`, `killCursors`

DB가 여러 개면 각 DB에 개별로 `read`를 부여하거나 클러스터 전역에 `readAnyDatabase`를 부여합니다. 예:

```js
// mongosh — admin DB에서 실행
use admin;
db.createUser({
  user: 'app_reader',
  pwd: '<password>',
  roles: [ { role: 'read', db: '<target-db>' } ],
});
```

쓰기 역할(`readWrite`, `dbOwner`, `root`)은 **부여하지 않습니다** — LLM 경유 조회 채널이 실수로도 쓰기 stage(`$out`, `$merge`, `insert`, `update`, `delete`)를 만들 수 없도록 계정 자체를 읽기 전용으로 유지합니다. 파이프라인의 `$out`·`$merge` 차단은 [`aggregate.md`](./aggregate.md#파이프라인-보안-검증) 참고.

## URI 조립

```ts
const MONGO_URI: string =
  `mongodb://${DB_USER_NAME}:${DB_USER_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_DATABASE}?authSource=admin`;
```

- 인증 DB는 `authSource=admin`으로 고정합니다. 사용자 계정이 관리자 DB에 만들어져 있다는 가정.
- 프로토콜은 `mongodb://` 단일 노드만 사용합니다. 레플리카셋·SRV(`mongodb+srv://`)를 쓰려면 URI 조립 규칙 자체를 바꿔야 합니다.
- 비밀번호에 `@`, `:`, `/`, `?`, `#`가 들어가면 반드시 `encodeURIComponent`로 감싼 뒤 URI에 삽입합니다.

## MongoClient 생성

```ts
const mongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
```

- **`maxPoolSize: 5`** — 소규모 데모 서버라 5로 고정. LLM 조회는 순차적으로 발생하므로 이 이상 늘려도 이득이 적습니다.
- 클라이언트 인스턴스는 모듈 최상단에서 한 번만 만들고, 요청 핸들러가 참조합니다.

## 연결 시작과 서버 부팅

```ts
mongoClient
  .connect()
  .then(() => {
    console.log(`MongoDB 연결 완료: ${DB_HOST}:${DB_PORT}/${DB_DATABASE}`);
    const server = app.listen(Number(PORT), () => {
      console.log(`서버 실행 중: http://localhost:${PORT}`);
    });
  })
  .catch((err: Error) => {
    console.error('MongoDB 연결 실패:', err.message);
    process.exit(1);
  });
```

- DB에 붙지 못하면 HTTP 서버는 아예 뜨지 않습니다 — 이후 요청이 500을 뱉는 상태를 만들지 않기 위함.
- 연결 실패 시 exit code 1로 프로세스 종료 → 컨테이너/PM2가 재시작 정책에 따라 재시도.

## 종료 처리

```ts
process.on('SIGINT', async () => {
  await mongoClient.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await mongoClient.close();
  process.exit(0);
});
```

프로세스 종료 신호를 받으면 커넥션을 정리하고 나갑니다. `close()`를 기다리지 않으면 서버 종료 후 MongoDB 로그에 half-closed 커넥션 경고가 남습니다.

## 쿼리 타임아웃

```ts
const DB_TIMEOUT_MS: number = 30_000;
const DB_TIMEOUT_MSG: string = 'DB 응답시간 초과 Max 30초';

await db.collection(name).countDocuments(filter, { maxTimeMS: DB_TIMEOUT_MS });
```

- 모든 `find` / `countDocuments` / `aggregate` 호출에 `maxTimeMS: 30_000` 옵션을 붙입니다.
- 서버 측 타임아웃(30초)이 걸리면 드라이버가 `err.code === 50` (MongoDB `MaxTimeMSExpired`)로 throw — 서버는 이를 감지해 HTTP 504로 응답합니다.

```ts
function isTimeoutError(err: unknown): boolean {
  return (err as { code?: number }).code === 50;
}
```

## `Db` 인스턴스 접근

요청마다 필요한 database 이름으로 `Db` 인스턴스를 뽑습니다:

```ts
const db: Db = mongoClient.db(database ?? DB_DATABASE!);
```

- 요청 body의 `database` 필드가 있으면 우선 사용, 없으면 `.env`의 기본 DB로 폴백.
- `mongoClient.db(name)`는 가벼운 참조 생성이므로 매 요청마다 호출해도 무방합니다.

## 새 조합 템플릿 만들 때 체크리스트

1. 위 5개 환경 변수(`DB_HOST` ~ `DB_USER_PASSWORD`)를 `.env.example`에 명시.
2. 계정에 대상 DB의 `read` 역할이 부여돼 있는지 확인 — 스키마(`listCollections`/`listIndexes`)와 데이터(`find`) 조회 권한이 모두 필요합니다. 쓰기 역할은 부여하지 않습니다.
3. URI 조립 규칙 유지 — 레플리카셋/SRV로 확장하려면 이 문서를 먼저 갱신하고 통일된 규약으로 반영.
4. `MongoClient` 생성은 모듈 최상단에서 1회. 요청마다 새로 만들지 않습니다.
5. `.connect()` 성공 후에만 `app.listen()`을 호출하는 순서 유지.
6. `SIGINT`/`SIGTERM` 핸들러에서 `mongoClient.close()`를 반드시 호출.
