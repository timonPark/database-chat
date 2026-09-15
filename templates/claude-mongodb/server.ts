import 'dotenv/config';
import express, { Request, Response, Application } from 'express';
import { spawn, execSync, ChildProcess } from 'child_process';
import { MongoClient, ObjectId, Decimal128, Document, Filter, Sort, Db, FindCursor, WithId } from 'mongodb';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';

// ── 환경 변수 ──────────────────────────────────────────────────────────────────

const PORT: string = process.env.PORT ?? '3111';
const DB_HOST: string | undefined = process.env.DB_HOST;
const DB_PORT: string = process.env.DB_PORT ?? '27017';
const DB_DATABASE: string | undefined = process.env.DB_DATABASE;
const DB_USER_NAME: string | undefined = process.env.DB_USER_NAME;
const DB_USER_PASSWORD: string | undefined = process.env.DB_USER_PASSWORD;
const COLLECTION_MAPPING_FILE: string = process.env.COLLECTION_MAPPING_FILE ?? './collection-mapping.md';
const CLAUDE_MODEL: string = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
const CLAUDE_MAX_TURNS: string = process.env.CLAUDE_MAX_TURNS ?? '10';
const COLLECTION_INDEX_FILE: string = './index.md';
const COLLECTIONS_DIR: string = path.resolve(import.meta.dirname, 'collections');

if (!DB_HOST || !DB_DATABASE || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경 변수가 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

const MONGO_URI: string = `mongodb://${DB_USER_NAME}:${DB_USER_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_DATABASE}?authSource=admin`;

// ── 타입 정의 ──────────────────────────────────────────────────────────────────

type Projection = Record<string, 0 | 1 | boolean>;

interface QueryParams {
  database: string;
  collection: string;
  filter: Document;
  projection: Projection;
  sort?: Sort;
  pipeline?: Document[];
}

interface DbQueryBody {
  requestId?: string;
  database?: string;
  collection?: string;
  filter?: Document;
  projection?: Projection;
  sort?: Sort;
  limit?: number;
}

interface DbAggregateBody {
  requestId?: string;
  database?: string;
  collection?: string;
  pipeline?: Document[];
}

interface DbExportBody {
  requestId: string;
}

interface ChatBody {
  message?: string;
  requestId?: string;
  limit?: number;
}

interface CancelBody {
  requestId: string;
}

type SseEventType = 'progress' | 'log' | 'result' | 'error' | 'cancelled';
type SendFn = (type: SseEventType, msg: string) => void;

// Claude stream-json 이벤트 타입
interface ClaudeToolUseBlock {
  type: 'tool_use';
  name: string;
  input?: { command?: string };
}

interface ClaudeTextBlock {
  type: 'text';
  text?: string;
}

type ClaudeContentBlock = ClaudeToolUseBlock | ClaudeTextBlock;

interface ClaudeSystemEvent {
  type: 'system';
}

interface ClaudeAssistantEvent {
  type: 'assistant';
  message?: { content?: ClaudeContentBlock[] };
}

interface ClaudeToolResultBlock {
  type: 'tool_result';
  content?: string | { type?: string; text?: string }[];
}

interface ClaudeUserEvent {
  type: 'user';
  message?: { content?: ClaudeToolResultBlock[] };
}

interface ClaudeResultEvent {
  type: 'result';
  subtype: string;
  result?: string;
  cost_usd?: number;
}

type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent;

// ── 컬렉션 인덱스 로드 ─────────────────────────────────────────────────────────

let collectionIndex: string = '';
let collectionUpdatedAt: string = '';

try {
  collectionIndex = fs.readFileSync(path.resolve(COLLECTION_INDEX_FILE), 'utf-8');
  const match: RegExpMatchArray | null = collectionIndex.match(/최종 업데이트[：:]\s*(.+)/);
  if (match) collectionUpdatedAt = match[1].trim();
} catch {
  console.warn(`컬렉션 인덱스 파일을 읽을 수 없습니다: ${COLLECTION_INDEX_FILE}`);
  try {
    collectionIndex = fs.readFileSync(path.resolve(COLLECTION_MAPPING_FILE), 'utf-8');
  } catch {
    console.warn(`컬렉션 매핑 파일도 읽을 수 없습니다: ${COLLECTION_MAPPING_FILE}`);
  }
}

function loadCollectionIndex(): string {
  try {
    const content: string = fs.readFileSync(path.resolve(COLLECTION_INDEX_FILE), 'utf-8');
    const match: RegExpMatchArray | null = content.match(/최종 업데이트[：:]\s*(.+)/);
    if (match) collectionUpdatedAt = match[1].trim();
    return content;
  } catch {
    return collectionIndex;
  }
}

function buildCollectionSummary(): string {
  const lines: string[] = loadCollectionIndex().split('\n');
  const result: string[] = [];
  for (const line of lines) {
    const match: RegExpMatchArray | null = line.match(/\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/);
    if (match) result.push(`${match[1].trim()} — ${match[2].trim()}`);
  }
  return result.join('\n');
}

function buildCollectionGuide(): string {
  try {
    const lines: string[] = fs.readFileSync(path.resolve(COLLECTION_MAPPING_FILE), 'utf-8').split('\n');
    return lines
      .filter((line: string) => line.trim().startsWith('| `'))
      .map((line: string) => line.replace(/\s+/g, ' ').trim())
      .join('\n');
  } catch {
    return '';
  }
}

function buildSystemPrompt(requestId: string, limit: number = 20): string {
  return `MongoDB 조회 어시스턴트. 설명 없이 즉시 curl로 쿼리 실행 후 결과를 한국어로 답한다.

[컬렉션]
${buildCollectionSummary()}

[컬렉션 선택 가이드: 컬렉션명 | 자연어 키워드 | 주요 필드 | 설명]
${buildCollectionGuide()}

[필드 확인] 필드명 불확실 시: cat "${COLLECTIONS_DIR}/<컬렉션명>.md"

[단일 컬렉션] curl -sX POST http://localhost:${PORT}/db-query -H 'Content-Type: application/json' -d '{"requestId":"${requestId}","collection":"...","filter":{...},"projection":{...},"limit":${limit}}'

[조인/집계] curl -sX POST http://localhost:${PORT}/db-aggregate -H 'Content-Type: application/json' -d '{"requestId":"${requestId}","collection":"...","pipeline":[{"$match":{...}},{"$lookup":{"from":"...","localField":"...","foreignField":"_id","as":"..."}},{"$unwind":"$..."},{"$group":{...}}]}'

규칙:
- password·passHash 는 반드시 제외
- Date/ObjectId/Decimal128 조건은 MongoDB Extended JSON을 사용한다: {"$date":"2020-01-01T00:00:00.000Z"}, {"$oid":"..."}, {"$numberDecimal":"123.45"}
- 단순 필터·정렬·필드 선택은 /db-query 사용, $group·$lookup·$unwind·계산 필드가 필요할 때만 /db-aggregate 사용
- 집계는 가능한 한 초반에 $match를 두고, 반환 필드 제한은 마지막 $project 또는 $unset으로 처리한다
- $lookup 사용 시 반드시 $group으로 중복 제거 (1:N 조인 시 중복 발생)
- $lookup 대상은 같은 database의 컬렉션만 가능하며, 조인 대상 foreignField에 맞는 필드 타입(ObjectId/Number/String)을 확인한다
- $group에서 조인 대상 필드는 $first로 전체 수집 후 $replaceRoot로 루트 교체 — 필드를 개별 나열하지 말 것
- $limit은 반드시 ${limit}을 사용한다. 엑셀 내보내기는 동일 쿼리를 그대로 실행함
- 결과 없으면 즉시 "조회된 데이터가 없습니다"
- 출력이 파일로 저장되면 파일 읽지 말고 $group으로 줄여 재쿼리
- 오류 시 원인 설명
- 거래 내역(transactions) 조회 요청 시 쿼리 실행 전에 반드시 먼저 물어본다: "요약(계좌별 거래 건수 합계)으로 보시겠어요, 아니면 개별 거래 건 단위(로우)로 보시겠어요?" — 사용자가 답하면 그에 맞게 쿼리한다`;
}

// ── MongoDB 클라이언트 ─────────────────────────────────────────────────────────

const mongoClient: MongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 5 });

// ── 유틸 ──────────────────────────────────────────────────────────────────────

const ts: () => string = () => new Date().toTimeString().slice(0, 8);

const DB_TIMEOUT_MS: number = 30_000;
const DB_TIMEOUT_MSG: string = 'DB 응답시간 초과 Max 30초';

function isTimeoutError(err: unknown): boolean {
  return (err as { code?: number }).code === 50; // MongoDB MaxTimeMSExpired
}

const OID_REGEX: RegExp = /^[0-9a-fA-F]{24}$/;

function convertOid(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(convertOid);
  if (obj !== null && typeof obj === 'object') {
    if ('$oid' in obj) return new ObjectId((obj as { $oid: string }).$oid);
    if ('$date' in obj) {
      const value = (obj as { $date: string | { $numberLong: string } }).$date;
      return new Date(typeof value === 'string' ? value : Number(value.$numberLong));
    }
    if ('$numberDecimal' in obj) return Decimal128.fromString((obj as { $numberDecimal: string }).$numberDecimal);
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, convertOid(v)])
    );
  }
  if (typeof obj === 'string' && OID_REGEX.test(obj)) return new ObjectId(obj);
  return obj;
}

function applyProjectionSecurity(projection: Projection): void {
  const isInclusion: boolean = Object.values(projection).some(v => v === 1 || v === true);
  if (isInclusion) {
    delete projection.passHash;
    delete projection.password;
  } else {
    projection.passHash = 0;
    projection.password = 0;
  }
}

const BLOCKED_AGGREGATION_STAGES: Set<string> = new Set(['$out', '$merge']);
const SENSITIVE_FIELDS: string[] = ['password', 'passHash'];

function getAggregationStageName(stage: Document): string | undefined {
  return Object.keys(stage)[0];
}

function assertReadOnlyPipeline(pipeline: Document[]): void {
  for (const stage of pipeline) {
    const name = getAggregationStageName(stage);
    if (name && BLOCKED_AGGREGATION_STAGES.has(name)) {
      throw new Error(`${name} 단계는 읽기 전용 조회에서 사용할 수 없습니다.`);
    }
    if ('$lookup' in stage) {
      const lookup = stage.$lookup as { pipeline?: Document[] };
      if (Array.isArray(lookup.pipeline)) assertReadOnlyPipeline(lookup.pipeline);
    }
    if ('$facet' in stage) {
      const facet = stage.$facet as Record<string, Document[]>;
      for (const nested of Object.values(facet)) {
        if (Array.isArray(nested)) assertReadOnlyPipeline(nested);
      }
    }
    if ('$unionWith' in stage) {
      const unionWith = stage.$unionWith as { pipeline?: Document[] };
      if (Array.isArray(unionWith.pipeline)) assertReadOnlyPipeline(unionWith.pipeline);
    }
  }
}

function isPresentationStage(stage: Document): boolean {
  return '$project' in stage || '$unset' in stage;
}

function pipelineForCount(pipeline: Document[]): Document[] {
  let lastNonProjectIndex: number = -1;
  for (let i = pipeline.length - 1; i >= 0; i -= 1) {
    if (!isPresentationStage(pipeline[i])) {
      lastNonProjectIndex = i;
      break;
    }
  }
  const lastNonProject: Document | undefined = lastNonProjectIndex >= 0 ? pipeline[lastNonProjectIndex] : undefined;
  const isTerminalLimit: boolean = lastNonProject != null && '$limit' in lastNonProject;
  if (!isTerminalLimit) return pipeline;
  return pipeline.slice(0, lastNonProjectIndex);
}

function pipelineWithoutTerminalLimit(pipeline: Document[]): Document[] {
  const lastNonProject: Document | undefined = [...pipeline].reverse().find((s: Document) => !isPresentationStage(s));
  const isTerminalLimit: boolean = lastNonProject != null && '$limit' in lastNonProject;
  return pipeline.filter((stage: Document) => !(isTerminalLimit && stage === lastNonProject));
}

function withSensitiveFieldsUnset(pipeline: Document[]): Document[] {
  return [...pipeline, { $unset: SENSITIVE_FIELDS }];
}

// ── Claude 이벤트 핸들러 ──────────────────────────────────────────────────────

function createClaudeEventHandler(send: SendFn): (event: ClaudeEvent) => void {
  let systemSeen: boolean = false;
  let lastEventType: string = '';

  return function handleClaudeEvent(event: ClaudeEvent): void {
    switch (event.type) {
      case 'system':
        if (!systemSeen) {
          systemSeen = true;
          console.log(`${ts()} [준비]      Claude 세션 시작`);
          send('progress', '준비 중...');
        }
        break;

      case 'assistant': {
        const contents: ClaudeContentBlock[] = event.message?.content ?? [];
        const hasToolUse: boolean = contents.some(b => b.type === 'tool_use');
        const hasText: boolean = contents.some(b => b.type === 'text');

        if (hasToolUse) {
          for (const block of contents) {
            if (block.type !== 'tool_use' || block.name !== 'Bash') continue;
            const cmd: string = block.input?.command?.trim() ?? '';
            if (cmd.includes('/db-query') || cmd.includes('/db-aggregate')) {
              const isAgg: boolean = cmd.includes('/db-aggregate');
              console.log(`${ts()} [조회 시작]  DB ${isAgg ? '집계' : '쿼리'} 실행 중...`);
              console.log(`             $ ${cmd}`);
              send('progress', `조회 시작 — DB ${isAgg ? '집계' : '쿼리'} 실행 중...`);
              const singleMatch: RegExpMatchArray | null = cmd.match(/-d\s+'([^']+)'/);
              const doubleMatch: RegExpMatchArray | null = cmd.match(/-d\s+"((?:[^"\\]|\\.)*)"/);
              const rawData: string | undefined = singleMatch?.[1] ?? doubleMatch?.[1]?.replace(/\\"/g, '"');
              if (rawData) {
                try {
                  const parsed: unknown = JSON.parse(rawData);
                  const display: string = JSON.stringify(parsed, null, 2);
                  send('log', display.length > 600 ? display.slice(0, 600) + '\n...(생략)' : display);
                } catch {
                  const collMatch: RegExpMatchArray | null = rawData.match(/["']collection["']\s*:\s*["']([^"']+)["']/);
                  send('log', collMatch ? `collection: ${collMatch[1]}` : rawData.slice(0, 200));
                }
              } else {
                const fallbackMatch: RegExpMatchArray | null = cmd.match(/["']collection["']\s*:\s*["']([^"']+)["']/);
                if (fallbackMatch) send('log', `collection: ${fallbackMatch[1]}`);
              }
            } else if (cmd.startsWith('cat') && !cmd.includes('|')) {
              // 순수 스키마 파일 읽기
              const file: string | undefined = cmd.replace('cat', '').trim().split('/').pop();
              console.log(`${ts()} [필드 확인]  ${file} 스키마 읽는 중...`);
              send('progress', `필드 확인 — ${file} 스키마 읽는 중...`);
              send('log', `$ cat ${file}`);
            } else {
              // jq·python 가공, 기타 명령
              const label: string = cmd.includes('jq') || cmd.includes('python')
                ? '결과 가공 중...'
                : '실행 중...';
              console.log(`${ts()} [실행]      $ ${cmd.slice(0, 80)}`);
              send('progress', label);
              send('log', `$ ${cmd.length > 120 ? cmd.slice(0, 120) + '...' : cmd}`);
            }
          }
        } else if (hasText && lastEventType === 'user') {
          // DB 응답을 받은 직후에만 "응답값 생성 중..." 표시
          console.log(`${ts()} [응답 생성]  응답값 생성 중...`);
          send('progress', '응답값 생성 중...');
        }
        break;
      }

      case 'user': {
        const blocks: ClaudeToolResultBlock[] = event.message?.content ?? [];
        for (const block of blocks) {
          if (block.type !== 'tool_result') continue;
          const raw: string = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(c => c.text ?? '').join('')
              : '';
          const text: string = raw.trim();
          if (!text) break;
          try {
            const parsed = JSON.parse(text) as { count?: number; dbTimeMs?: number; error?: string };
            if (typeof parsed.count === 'number') {
              const dbSec: string = parsed.dbTimeMs != null
                ? ` / DB실행: ${(parsed.dbTimeMs / 1000).toFixed(2)}초`
                : '';
              const detail: string = `${parsed.count}건 수신${dbSec}`;
              console.log(`${ts()} [DB 응답 확인] ${detail}`);
              send('progress', `DB 응답 확인 — ${detail}`);
            } else if (typeof parsed.error === 'string') {
              console.log(`${ts()} [DB 오류] ${parsed.error}`);
              send('progress', `DB 오류 — ${parsed.error}`);
            }
            // count도 error도 없는 JSON(스키마 등) → 무시
          } catch {
            // JSON이 아닌 파일 내용(스키마 읽기 결과) → 무시
          }
        }
        break;
      }

      case 'result':
        if (event.subtype === 'success') {
          console.log(`${ts()} [응답 완료]  cost=$${event.cost_usd?.toFixed(4) ?? '?'}`);
        } else {
          console.log(`${ts()} [실패]      subtype=${event.subtype}`);
        }
        break;
    }

    lastEventType = event.type;
  };
}

// ── Express 앱 ────────────────────────────────────────────────────────────────

const app: Application = express();
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, 'public')));

const activeJobs: Map<string, ChildProcess> = new Map();
const queryParamsStore: Map<string, QueryParams> = new Map();

// ── 엔드포인트 ────────────────────────────────────────────────────────────────

app.get('/meta', (_req: Request, res: Response) => {
  res.json({ updatedAt: collectionUpdatedAt });
});

app.get('/meta/table-info', (_req: Request, res: Response) => {
  res.json({ content: loadCollectionIndex() });
});

app.post('/db-query', async (req: Request<object, object, DbQueryBody>, res: Response) => {
  const {
    requestId,
    database,
    collection,
    filter = {},
    projection = {},
    sort,
    limit = 20,
  } = req.body;

  if (!collection) {
    return res.status(400).json({ error: 'collection 필드가 필요합니다.' });
  }

  const targetDb: string = database ?? DB_DATABASE!;
  const qParams: QueryParams = { database: targetDb, collection, filter, projection, sort };
  if (requestId && collection) queryParamsStore.set(requestId, qParams);
  queryParamsStore.set('__latest__', qParams);

  applyProjectionSecurity(projection);

  try {
    const db: Db = mongoClient.db(targetDb);
    const convertedFilter = convertOid(filter) as Filter<Document>;

    const dbStart: number = Date.now();

    // Step 1: 전체 건수 확인
    const totalCount: number = await db.collection(collection).countDocuments(convertedFilter, { maxTimeMS: DB_TIMEOUT_MS });

    if (totalCount === 0) {
      const dbTimeMs: number = Date.now() - dbStart;
      return res.json({ count: 0, data: [], dbTimeMs, message: '조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라.' });
    }

    // Step 2: 건수 기반 limit 적용하여 본 쿼리 실행
    let cursor: FindCursor<WithId<Document>> = db
      .collection(collection)
      .find(convertedFilter, { projection: convertOid(projection) as Document })
      .maxTimeMS(DB_TIMEOUT_MS);
    if (sort) cursor = cursor.sort(sort);
    const docs: WithId<Document>[] = await cursor.limit(limit).toArray();
    const dbTimeMs: number = Date.now() - dbStart;

    return res.json({ count: totalCount, data: docs, dbTimeMs });
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(`${ts()} [타임아웃] ${DB_TIMEOUT_MSG} — ${collection}`);
      return res.status(504).json({ error: DB_TIMEOUT_MSG });
    }
    console.error(`[DB 오류] ${(err as Error).message}`);
    return res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/db-aggregate', async (req: Request<object, object, DbAggregateBody>, res: Response) => {
  const {
    requestId,
    database,
    collection,
    pipeline = [],
  } = req.body;

  if (!collection) {
    return res.status(400).json({ error: 'collection 필드가 필요합니다.' });
  }
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    return res.status(400).json({ error: 'pipeline 배열이 필요합니다.' });
  }

  const targetDb: string = database ?? DB_DATABASE!;

  try {
    const db: Db = mongoClient.db(targetDb);
    const pipelineArr: Document[] = pipeline as Document[];
    assertReadOnlyPipeline(pipelineArr);

    // $project 직전(또는 맨 끝)의 $limit만 "미리보기 limit"으로 판별
    const lastNonProject: Document | undefined = [...pipelineArr].reverse().find((s: Document) => !('$project' in s));
    const isTerminalLimit: boolean = lastNonProject != null && '$limit' in lastNonProject;

    const execPipeline: Document[] = withSensitiveFieldsUnset(pipelineArr);

    const dbStart: number = Date.now();
    let docs: Document[];
    let totalCount: number;

    if (isTerminalLimit) {
      // 미리보기 $limit 감지 → count 쿼리와 exec를 병렬 실행해 실제 전체 건수 확인
      const countPipeline: Document[] = [
        ...pipelineForCount(pipelineArr),
        { $count: 'total' },
      ];
      const [countResult, docsResult]: [Document[], Document[]] = await Promise.all([
        db.collection(collection).aggregate(convertOid(countPipeline) as Document[], { maxTimeMS: DB_TIMEOUT_MS }).toArray(),
        db.collection(collection).aggregate(convertOid(execPipeline) as Document[], { maxTimeMS: DB_TIMEOUT_MS }).toArray(),
      ]);
      totalCount = (countResult[0]?.total as number) ?? docsResult.length;
      docs = docsResult;
    } else {
      // 로직 $limit이거나 $limit 없음 → 단일 쿼리, 결과 건수가 곧 전체 건수
      docs = await db.collection(collection).aggregate(convertOid(execPipeline) as Document[], { maxTimeMS: DB_TIMEOUT_MS }).toArray();
      totalCount = docs.length;
    }

    const dbTimeMs: number = Date.now() - dbStart;

    const aggParams: QueryParams = { database: targetDb, collection, filter: {}, projection: {}, pipeline: pipelineArr };
    if (requestId) queryParamsStore.set(requestId, aggParams);
    queryParamsStore.set('__latest__', aggParams);

    if (totalCount === 0) {
      return res.json({ count: 0, data: [], dbTimeMs, message: '조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라.' });
    }
    return res.json({ count: totalCount, data: docs, dbTimeMs });
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(`${ts()} [타임아웃] ${DB_TIMEOUT_MSG} — ${collection}`);
      return res.status(504).json({ error: DB_TIMEOUT_MSG });
    }
    console.error(`[DB 집계 오류] ${(err as Error).message}`);
    return res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/db-export', async (req: Request<object, object, DbExportBody>, res: Response) => {
  const { requestId } = req.body;
  const params: QueryParams | undefined = queryParamsStore.get(requestId) ?? queryParamsStore.get('__latest__');
  if (!params) {
    return res.status(404).json({ error: '조회 파라미터를 찾을 수 없습니다. 먼저 검색을 실행해 주세요.' });
  }

  const { database: exportDb, collection, filter, projection, sort, pipeline } = params;

  try {
    const db: Db = mongoClient.db(exportDb ?? DB_DATABASE!);
    let docs: Document[];

    if (pipeline && pipeline.length > 0) {
      assertReadOnlyPipeline(pipeline);
      // 터미널 $limit만 제거하고, $project는 보존해 사용자가 본 필드 형태와 내보내기 형태를 맞춘다.
      const exportPipeline: Document[] = withSensitiveFieldsUnset(pipelineWithoutTerminalLimit(pipeline));
      docs = await db
        .collection(collection)
        .aggregate(exportPipeline, { maxTimeMS: DB_TIMEOUT_MS })
        .toArray();
    } else {
      const safeProjection: Projection = { ...projection };
      applyProjectionSecurity(safeProjection);
      let cursor: FindCursor<WithId<Document>> = db
        .collection(collection)
        .find(convertOid(filter) as Filter<Document>, { projection: convertOid(safeProjection) as Document })
        .maxTimeMS(DB_TIMEOUT_MS);
      if (sort) cursor = cursor.sort(sort);
      docs = await cursor.toArray();
    }

    console.log(`${ts()} [엑셀 내보내기] ${collection} ${docs.length}건`);
    return res.json({ count: docs.length, data: docs, collection });
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(`${ts()} [타임아웃] ${DB_TIMEOUT_MSG} — ${collection}`);
      return res.status(504).json({ error: DB_TIMEOUT_MSG });
    }
    console.error(`[DB 내보내기 오류] ${(err as Error).message}`);
    return res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/chat/cancel', (req: Request<object, object, CancelBody>, res: Response) => {
  const { requestId } = req.body;
  const child: ChildProcess | undefined = activeJobs.get(requestId);
  if (child) {
    child.kill();
    activeJobs.delete(requestId);
    console.log(`${ts()} [중지]      요청 취소: ${requestId}`);
    res.json({ ok: true });
  } else {
    res.json({ ok: false });
  }
});

app.post('/chat', (req: Request<object, object, ChatBody>, res: Response) => {
  const { message, requestId, limit = 20 } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: '메시지를 입력해 주세요.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send: SendFn = (type: SseEventType, msg: string): void => {
    res.write(`data: ${JSON.stringify({ type, message: msg })}\n\n`);
  };

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[요청] ${message.trim()}`);
  console.log(`${'─'.repeat(60)}`);

  const child: ChildProcess = spawn(
    'claude',
    [
      '-p', message.trim(),
      '--allowedTools', 'Bash',
      '--system-prompt', buildSystemPrompt(requestId ?? '', limit),
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', CLAUDE_MAX_TURNS,
      '--model', CLAUDE_MODEL,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  if (requestId) activeJobs.set(requestId, child);

  const handleClaudeEvent = createClaudeEventHandler(send);
  let lineBuffer: string = '';
  let finalResult: string = '';
  let stderr: string = '';

  child.stdout!.on('data', (data: Buffer) => {
    lineBuffer += data.toString();
    const lines: string[] = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event: ClaudeEvent = JSON.parse(line) as ClaudeEvent;
        handleClaudeEvent(event);
        if (event.type === 'result' && event.subtype === 'success') {
          finalResult = event.result ?? '';
        }
      } catch { /* 파싱 불가 라인 무시 */ }
    }
  });

  child.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });

  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (requestId) activeJobs.delete(requestId);
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      send('cancelled', '조회가 중지되었습니다.');
    } else if (code !== 0 && !finalResult) {
      console.error('[오류] Claude 프로세스 실패 (exit code:', code, ')');
      console.error(stderr);
      send('error', 'Claude 프로세스 실행 실패: ' + stderr.slice(0, 200));
    } else {
      send('result', finalResult.trim());
    }
    console.log(`${'─'.repeat(60)}\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  child.on('error', (err: NodeJS.ErrnoException) => {
    send('error', err.code === 'ENOENT' ? 'Claude CLI가 설치되어 있지 않습니다.' : err.message);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ── 서버 시작 ─────────────────────────────────────────────────────────────────

function killPort(port: string): void {
  try {
    const pids: string = execSync(`lsof -ti :${port}`).toString().trim();
    if (pids) {
      pids.split('\n').forEach((pid: string) => {
        try { process.kill(Number(pid), 'SIGKILL'); } catch { /* 무시 */ }
      });
      console.log(`포트 ${port} 점유 프로세스 종료 완료`);
    }
  } catch { /* 점유 프로세스 없음 */ }
}

mongoClient
  .connect()
  .then((): void => {
    console.log(`MongoDB 연결 완료: ${DB_HOST}:${DB_PORT}/${DB_DATABASE}`);
    const server: Server = app.listen(Number(PORT), (): void => {
      console.log(`서버 실행 중: http://localhost:${PORT}`);
    });
    server.on('error', (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        console.log(`포트 ${PORT} 사용 중 — 기존 프로세스 종료 후 재시작...`);
        killPort(PORT);
        setTimeout((): void => {
          server.listen(Number(PORT), (): void => {
            console.log(`서버 실행 중: http://localhost:${PORT}`);
          });
        }, 500);
      } else {
        console.error('서버 오류:', err.message);
        process.exit(1);
      }
    });
  })
  .catch((err: Error): void => {
    console.error('MongoDB 연결 실패:', err.message);
    process.exit(1);
  });

process.on('SIGINT', async (): Promise<void> => {
  await mongoClient.close();
  console.log('MongoDB 커넥션 종료');
  process.exit(0);
});

process.on('SIGTERM', async (): Promise<void> => {
  await mongoClient.close();
  console.log('MongoDB 커넥션 종료');
  process.exit(0);
});
