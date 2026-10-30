import 'dotenv/config';
import express, { Request, Response, Application } from 'express';
import { spawn, execSync, ChildProcess } from 'child_process';
import { MongoClient, ObjectId, Decimal128, Document, Filter, Sort, Db, FindCursor, WithId } from 'mongodb';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadAllSchemas } from './scripts/load-schema-index.js';
import { analyzePipeline } from './scripts/pipeline-analyze.js';
import { buildColumnsFromQuery, buildColumnsFromPipeline } from './scripts/build-columns.js';
import { openHistoryDb, HistoryDbValidationError, PROMOTED_REASON_SIZE_CAP, type PromotedAttachmentRef } from './scripts/history-db.js';

// ── 환경 변수 ──────────────────────────────────────────────────────────────────

const PORT: string = process.env.PORT ?? '3111';
const DB_HOST: string | undefined = process.env.DB_HOST;
const DB_PORT: string = process.env.DB_PORT ?? '27017';
const DB_DATABASE: string | undefined = process.env.DB_DATABASE;
const DB_USER_NAME: string | undefined = process.env.DB_USER_NAME;
const DB_USER_PASSWORD: string | undefined = process.env.DB_USER_PASSWORD;
const COLLECTION_MAPPING_FILE: string = process.env.COLLECTION_MAPPING_FILE ?? './collection-mapping.md';
const GEMINI_MODEL: string = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash-medium';
const GEMINI_PRINT_TIMEOUT: string = process.env.GEMINI_PRINT_TIMEOUT?.trim() || '5m';
const COLLECTION_INDEX_FILE: string = './index.md';
const COLLECTIONS_DIR: string = path.resolve(import.meta.dirname, 'collections');

// agy 자식 프로세스에 상속시키지 않을 민감 키
// Why: LLM 이 spawn 된 프로세스의 env 를 통해 자격 증명을 유출하지 못하게 차단
const AGY_CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const SENSITIVE_KEYS: readonly string[] = [
    'DB_HOST', 'DB_PORT', 'DB_DATABASE',
    'DB_USER_NAME', 'DB_USER_PASSWORD',
  ];
  for (const key of SENSITIVE_KEYS) delete env[key];
  return env;
})();

// LLM CLI 작업 폴더 — .env 가 있는 프로젝트 루트가 아닌 빈 임시 폴더에서 실행한다 (#219).
// 프로젝트 루트에서 실행하면 codex(read-only 샌드박스) · agy(파일 보기 도구) 가 .env 를 읽을 수 있다.
// 스키마 문서는 서버가 직접 읽어 프롬프트에 넣으므로 CLI 는 프로젝트 파일이 필요 없다.
const CLI_WORKDIR: string = fs.mkdtempSync(path.join(os.tmpdir(), 'dbchat-cli-'));

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
  limit?: number;
}

interface DbExportBody {
  requestId: string;
  sessionId?: string;
  messageId?: string;
}

interface ChatBody {
  message?: string;
  requestId?: string;
  limit?: number;
  sessionId?: string;
}

interface CancelBody {
  requestId: string;
}

type SseEventType = 'progress' | 'log' | 'query' | 'result-data' | 'result' | 'error' | 'cancelled' | 'assistant-saved' | 'export-promoted';
type SendFn = (type: SseEventType, msg: unknown) => void;

// LLM 재주입용 attachment 메타의 단일 shape 정의 — 저장(/chat)과 조회(buildRecentContext)에서 공유.
type AssistantAttachments = { columns: unknown; rowCount: number };

interface QueryEventPayload {
  endpoint: '/db-query' | '/db-aggregate';
  requestBody: Record<string, unknown>;
}

interface ResultDataEventPayload {
  count: number;
  data: Document[];
  columns: unknown[];
  columnConfidence: 'full' | 'partial';
  unmappedKeys: string[];
  dbTimeMs: number;
  autoLimitedTo?: number;
  retried?: 'stringToNumber' | 'idxToObj';
}

// agy stream-json 이벤트 (실제 관측된 shape, `agy --output-format stream-json`)
interface AgyInitEvent {
  event: 'init';
  init?: { model?: string; permission_mode?: string };
}

type AgyStepType = 'user_input' | 'agent_response' | 'tool';
type AgyStepState = 'ACTIVE' | 'DONE';

interface AgyStepUpdate {
  step_index?: number;
  state?: AgyStepState;
  step_type?: AgyStepType;
  text_delta?: string;
  duration_seconds?: number;
}

interface AgyStepUpdateEvent {
  event: 'step_update';
  step_update: AgyStepUpdate;
}

interface AgyResultEvent {
  event: 'result';
  result?: { status?: string; response?: string; duration_seconds?: number };
}

type AgyEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent;

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

const schemaLoadResult = loadAllSchemas(COLLECTIONS_DIR);
if (schemaLoadResult.total === 0) {
  console.warn(`컬렉션 스키마 디렉토리가 비어있거나 없습니다: ${COLLECTIONS_DIR} (fallback: 원본 key 노출)`);
} else {
  const failedSuffix = schemaLoadResult.failed > 0 ? ` (실패 ${schemaLoadResult.failed}건)` : '';
  console.log(`컬렉션 스키마 인덱스 로드 완료: ${schemaLoadResult.loaded}/${schemaLoadResult.total}${failedSuffix}`);
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

function buildSystemPrompt(limit: number = 20): string {
  return `MongoDB 조회 쿼리 생성기. 사용자 자연어 요청 → **정확히 하나의 JSON 객체** 만 출력하고 종료.

**절대 규칙**:
- 응답은 오직 하나의 JSON 객체. 앞뒤에 설명·인사·마크다운 코드펜스·요약 어떤 것도 붙이지 마라
- 도구 · 명령 실행 없음. curl · bash · cat 등 사용 금지 (sandbox 활성화로 실행이 차단됨)
- 서버가 이 JSON 을 파싱해 DB 를 조회하고 결과를 UI 에 직접 그린다. 너는 결과를 볼 수 없고, 결과를 안내할 필요도 없다

**출력 형식** (둘 중 하나):

단일 컬렉션 조회:
{"kind":"query","collection":"<이름>","filter":{...},"projection":{...},"limit":${limit}}

집계 (조인·그룹):
{"kind":"aggregate","collection":"<이름>","pipeline":[{"$match":{...}}, ...]}

[컬렉션]
${buildCollectionSummary()}

[컬렉션 선택 가이드: 컬렉션명 | 자연어 키워드 | 주요 필드 | 설명]
${buildCollectionGuide()}

규칙:
- password · passHash 는 반드시 제외
- Date · ObjectId · Decimal128 조건은 MongoDB Extended JSON: {"$date":"2020-01-01T00:00:00.000Z"}, {"$oid":"..."}, {"$numberDecimal":"123.45"}
- 필드 네이밍 규약 — 접미사 \`Idx\` = String, \`Obj\` = ObjectId. \`Idx\` 필드는 절대 {"$oid":"..."} 로 감싸지 말 것 (문자열 그대로). \`Obj\` 필드는 {"$oid":"..."} 로 감쌈. "환자식별자" 같이 모호한 표현은 컬렉션 스키마에서 정확한 필드명 확인 (예: patientObj vs patientIdx)
- MongoDB 연산자는 반드시 $ 로 시작: $regex, $options, $in, $lt, $gte, $exists, $ne 등. "options"/"regex" 처럼 $ 누락 금지
- 대소문자 무시 검색은 {"$regex":"...","$options":"i"}
- 단순 필터 · 정렬 · 필드 선택은 kind:"query", $group · $lookup · $unwind · 계산 필드가 필요할 때만 kind:"aggregate"
- 집계는 가능한 한 초반에 $match, 반환 필드 제한은 마지막 $project 또는 $unset
- $lookup 은 항상 좌측 외부 조인, 결과는 배열(as 필드)
- $lookup 대상은 같은 database, foreignField 타입 (ObjectId · Number · String) 확인
- 조인 방향에 따른 중복 처리:
  · 좌측 1건 : 우측 N건 — 중복 방지 위해 $unwind 후 $group + $first + $replaceRoot 로 재구성
  · 좌측 N건 : 우측 1건 — 중복 없음, $unwind 만 하고 $group·$replaceRoot 금지
- kind:"query" 의 limit 및 kind:"aggregate" 파이프라인 마지막 stage 는 반드시 { "$limit": ${limit} }. aggregate 에서 누락 시 서버가 강제 주입`;
}

function buildGeminiPrompt(message: string, limit: number = 20, recentContext: string = ''): string {
  const userBlock: string = recentContext
    ? `${recentContext}\n\n${message}`
    : message;
  return `${buildSystemPrompt(limit)}

[사용자 질문]
${userBlock}`;
}

// ── MongoDB 클라이언트 ─────────────────────────────────────────────────────────

const mongoClient: MongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 5 });

// ── 유틸 ──────────────────────────────────────────────────────────────────────

const ts: () => string = () => new Date().toTimeString().slice(0, 8);

const DB_TIMEOUT_MS: number = 30_000;
const DB_TIMEOUT_MSG: string = 'DB 응답시간 초과 Max 30초';
const AGY_CLI_PATHS: string[] = [
  process.env.AGY_CLI_PATH ?? '',
  'agy',
  '/opt/homebrew/bin/agy',
].filter(Boolean);

function resolveAgyCli(): string {
  for (const candidate of AGY_CLI_PATHS) {
    try {
      execSync(`"${candidate}" --version`, { stdio: 'ignore' });
      return candidate;
    } catch { /* 다음 후보 확인 */ }
  }
  return 'agy';
}

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

// ── 문자열↔숫자 자동 재쿼리 ───────────────────────────────────────────────────
// LLM 이 결과를 안 보므로 이 로직이 서버에 있어야 재시도가 결정론적으로 일어난다.
const NUMERIC_STRING_REGEX = /^0?\d+$/;

// Extended JSON atomic marker / meta 연산자
const NO_RECURSE_OPS = new Set([
  '$oid', '$date', '$numberDecimal', '$numberLong', '$binary', '$timestamp',
  '$regex', '$options', '$type', '$exists', '$size', '$mod',
]);

const OID_HEX_REGEX_FULL = /^[0-9a-fA-F]{24}$/;

function isHex(v: unknown): v is string {
  return typeof v === 'string' && OID_HEX_REGEX_FULL.test(v);
}

function tryIdxToObjRewrite(key: string, value: unknown): { key: string; value: unknown } | null {
  if (!key.endsWith('Idx')) return null;
  const newKey = `${key.slice(0, -3)}Obj`;
  if (isHex(value)) return { key: newKey, value: { $oid: value } };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1) {
      const [op, val] = entries[0];
      if (op === '$eq' && isHex(val)) return { key: newKey, value: { $oid: val } };
      if (op === '$oid' && isHex(val)) return { key: newKey, value: { $oid: val } };
      if (op === '$in' && Array.isArray(val) && val.length > 0 && val.every(isHex)) {
        return { key: newKey, value: { $in: (val as string[]).map((h) => ({ $oid: h })) } };
      }
    }
  }
  return null;
}

function swapIdxToObjInFilter(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    const rs = value.map(swapIdxToObjInFilter);
    return { value: rs.map((r) => r.value), changed: rs.some((r) => r.changed) };
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && NO_RECURSE_OPS.has(entries[0][0])) {
      return { value, changed: false };
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      const rewrite = tryIdxToObjRewrite(k, v);
      if (rewrite) {
        out[rewrite.key] = rewrite.value;
        changed = true;
        continue;
      }
      const r = swapIdxToObjInFilter(v);
      out[k] = r.value;
      if (r.changed) changed = true;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

function swapNumericStringsInFilter(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    const results = value.map(swapNumericStringsInFilter);
    return {
      value: results.map((r) => r.value),
      changed: results.some((r) => r.changed),
    };
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && NO_RECURSE_OPS.has(entries[0][0])) {
      return { value, changed: false };
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      const r = swapNumericStringsInFilter(v);
      out[k] = r.value;
      if (r.changed) changed = true;
    }
    return { value: out, changed };
  }
  if (typeof value === 'string' && value.length >= 6 && NUMERIC_STRING_REGEX.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return { value: n, changed: true };
  }
  return { value, changed: false };
}

// ── 내부 실행 함수 (HTTP 라우트 및 /chat 이 공유) ───────────────────────────

interface QueryResultBody {
  count: number;
  data: Document[];
  dbTimeMs: number;
  columns: unknown[];
  columnConfidence?: 'full' | 'partial';
  unmappedKeys?: string[];
  message?: string;
  autoLimitedTo?: number;
  retried?: 'stringToNumber' | 'idxToObj';
}

interface ExecuteQueryParams {
  database: string;
  collection: string;
  filter: Document;
  projection: Projection;
  sort?: Sort;
  limit: number;
}

interface ExecuteAggregateParams {
  database: string;
  collection: string;
  pipeline: Document[];
  limit: number;
}

async function executeQueryInternal(params: ExecuteQueryParams): Promise<{ body: QueryResultBody; effectiveFilter: Document }> {
  const { database, collection, filter, projection, sort, limit } = params;
  applyProjectionSecurity(projection);

  const db: Db = mongoClient.db(database);
  let effectiveFilter: Document = filter;
  let convertedFilter = convertOid(filter) as Filter<Document>;
  let retried: 'stringToNumber' | 'idxToObj' | undefined;

  const dbStart: number = Date.now();

  let totalCount: number = await db.collection(collection).countDocuments(convertedFilter, { maxTimeMS: DB_TIMEOUT_MS });

  if (totalCount === 0) {
    const attempts: Array<{ name: 'stringToNumber' | 'idxToObj'; filter: Document }> = [];
    const numSwap = swapNumericStringsInFilter(filter);
    if (numSwap.changed) attempts.push({ name: 'stringToNumber', filter: numSwap.value as Document });
    const idxSwap = swapIdxToObjInFilter(filter);
    if (idxSwap.changed) attempts.push({ name: 'idxToObj', filter: idxSwap.value as Document });

    for (const attempt of attempts) {
      const retryConverted = convertOid(attempt.filter) as Filter<Document>;
      const retryCount: number = await db.collection(collection).countDocuments(retryConverted, { maxTimeMS: DB_TIMEOUT_MS });
      if (retryCount > 0) {
        console.log(`${ts()} [재쿼리]     ${attempt.name} → ${retryCount}건 발견 (collection=${collection})`);
        effectiveFilter = attempt.filter;
        convertedFilter = retryConverted;
        totalCount = retryCount;
        retried = attempt.name;
        break;
      }
    }
  }

  if (totalCount === 0) {
    const dbTimeMs: number = Date.now() - dbStart;
    const emptyCols = buildColumnsFromQuery(collection, [], projection);
    return {
      body: {
        count: 0,
        data: [],
        dbTimeMs,
        message: '조회된 데이터가 없습니다.',
        ...emptyCols,
      },
      effectiveFilter,
    };
  }

  let cursor: FindCursor<WithId<Document>> = db
    .collection(collection)
    .find(convertedFilter, { projection: convertOid(projection) as Document })
    .maxTimeMS(DB_TIMEOUT_MS);
  if (sort) cursor = cursor.sort(sort);
  const docs: WithId<Document>[] = await cursor.limit(limit).toArray();
  const dbTimeMs: number = Date.now() - dbStart;

  const cols = buildColumnsFromQuery(collection, docs, projection);
  const body: QueryResultBody = { count: totalCount, data: docs, dbTimeMs, ...cols };
  if (retried) body.retried = retried;
  return { body, effectiveFilter };
}

async function executeAggregateInternal(params: ExecuteAggregateParams): Promise<{ body: QueryResultBody; autoLimited: boolean }> {
  const { database, collection, pipeline, limit } = params;

  const db: Db = mongoClient.db(database);
  assertReadOnlyPipeline(pipeline);

  const lastNonProject: Document | undefined = [...pipeline].reverse().find((s: Document) => !('$project' in s));
  const hadTerminalLimit: boolean = lastNonProject != null && '$limit' in lastNonProject;
  const effectivePipeline: Document[] = hadTerminalLimit
    ? pipeline
    : [...pipeline, { $limit: limit }];
  const autoLimited: boolean = !hadTerminalLimit;

  const execPipeline: Document[] = withSensitiveFieldsUnset(effectivePipeline);
  const countPipeline: Document[] = [
    ...pipelineForCount(effectivePipeline),
    { $count: 'total' },
  ];

  const dbStart: number = Date.now();
  const [countResult, docsResult]: [Document[], Document[]] = await Promise.all([
    db.collection(collection).aggregate(convertOid(countPipeline) as Document[], { maxTimeMS: DB_TIMEOUT_MS }).toArray(),
    db.collection(collection).aggregate(convertOid(execPipeline) as Document[], { maxTimeMS: DB_TIMEOUT_MS }).toArray(),
  ]);
  const totalCount: number = (countResult[0]?.total as number) ?? docsResult.length;
  const docs: Document[] = docsResult;
  const dbTimeMs: number = Date.now() - dbStart;

  const analysis = analyzePipeline(collection, pipeline);

  if (totalCount === 0) {
    const emptyCols = buildColumnsFromPipeline(collection, [], analysis);
    return {
      body: {
        count: 0,
        data: [],
        dbTimeMs,
        message: '조회된 데이터가 없습니다.',
        ...emptyCols,
      },
      autoLimited,
    };
  }

  const cols = buildColumnsFromPipeline(collection, docs, analysis);
  const body: QueryResultBody = { count: totalCount, data: docs, dbTimeMs, ...cols };
  if (autoLimited) body.autoLimitedTo = limit;
  return { body, autoLimited };
}

// LLM 이 뱉는 최종 텍스트에서 JSON 추출.
function extractJsonFromText(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = stripped.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        const jsonText = stripped.slice(start, i + 1);
        try { return JSON.parse(jsonText); } catch { return null; }
      }
    }
  }
  return null;
}

interface LlmQueryPayload {
  kind: 'query' | 'aggregate';
  collection?: string;
  filter?: Document;
  projection?: Projection;
  sort?: Sort;
  limit?: number;
  pipeline?: Document[];
}

function isLlmQueryPayload(v: unknown): v is LlmQueryPayload {
  if (v === null || typeof v !== 'object') return false;
  const kind = (v as { kind?: unknown }).kind;
  return kind === 'query' || kind === 'aggregate';
}

// ── agy 이벤트 핸들러 ─────────────────────────────────────────────────────────
// LLM 은 도구가 없으므로 (sandbox 활성 + 프롬프트 규칙) step_update 의 tool 스텝이 발생해서는 안 됨.
// 발생하더라도 서버는 도구 결과를 사용하지 않는다. 진행 알림만 처리.

function createAgyEventHandler(send: SendFn): (event: AgyEvent) => void {
  let initSeen: boolean = false;
  let responseAnnounced: boolean = false;

  return function handleAgyEvent(event: AgyEvent): void {
    switch (event.event) {
      case 'init':
        if (!initSeen) {
          initSeen = true;
          console.log(`${ts()} [준비]      agy 세션 시작 (model=${event.init?.model ?? '?'})`);
          send('progress', '쿼리 생성 준비 중...');
        }
        break;

      case 'step_update': {
        const s: AgyStepUpdate = event.step_update;
        if (s?.step_type === 'agent_response' && s.state === 'ACTIVE' && !responseAnnounced) {
          responseAnnounced = true;
          send('progress', '쿼리 생성 중...');
        }
        break;
      }

      case 'result': {
        const status = event.result?.status ?? '';
        const dur: string = event.result?.duration_seconds != null
          ? ` duration=${event.result.duration_seconds.toFixed(2)}s`
          : '';
        if (status === 'SUCCESS') {
          console.log(`${ts()} [LLM 응답 완료]${dur}`);
        } else {
          console.log(`${ts()} [LLM 실패]  status=${status}${dur}`);
        }
        break;
      }
    }
  };
}

// ── Express 앱 ────────────────────────────────────────────────────────────────

const app: Application = express();
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, 'public')));

const activeJobs: Map<string, ChildProcess> = new Map();
const queryParamsStore: Map<string, QueryParams> = new Map();
const historyDb = openHistoryDb(import.meta.dirname);

// ── 엔드포인트 ────────────────────────────────────────────────────────────────

app.get('/meta', (_req: Request, res: Response) => {
  res.json({ updatedAt: collectionUpdatedAt });
});

app.get('/meta/table-info', (_req: Request, res: Response) => {
  res.json({ content: loadCollectionIndex() });
});

app.get('/meta/erd', (_req: Request, res: Response) => {
  const erdPath: string = path.resolve('erd.mmd');
  if (!fs.existsSync(erdPath)) {
    return res.json({ available: false, content: null });
  }
  try {
    const content: string = fs.readFileSync(erdPath, 'utf-8');
    return res.json({ available: true, content });
  } catch (err) {
    return res.json({ available: false, content: null, error: (err as Error).message });
  }
});

app.post('/db-query', async (req: Request<object, object, DbQueryBody>, res: Response) => {
  const { requestId, database, collection, filter = {}, projection = {}, sort, limit = 20 } = req.body;
  if (!collection) return res.status(400).json({ error: 'collection 필드가 필요합니다.' });

  const targetDb: string = database ?? DB_DATABASE!;
  const qParams: QueryParams = { database: targetDb, collection, filter, projection, sort };
  if (requestId) queryParamsStore.set(requestId, qParams);
  queryParamsStore.set('__latest__', qParams);

  try {
    const { body, effectiveFilter } = await executeQueryInternal({ database: targetDb, collection, filter, projection, sort, limit });
    if (body.retried && requestId) {
      const updated: QueryParams = { database: targetDb, collection, filter: effectiveFilter, projection, sort };
      queryParamsStore.set(requestId, updated);
      queryParamsStore.set('__latest__', updated);
    }
    return res.json(body);
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
  const { requestId, database, collection, pipeline = [], limit = 20 } = req.body;
  if (!collection) return res.status(400).json({ error: 'collection 필드가 필요합니다.' });
  if (!Array.isArray(pipeline) || pipeline.length === 0) return res.status(400).json({ error: 'pipeline 배열이 필요합니다.' });

  const targetDb: string = database ?? DB_DATABASE!;

  try {
    const pipelineArr: Document[] = pipeline as Document[];
    const { body } = await executeAggregateInternal({ database: targetDb, collection, pipeline: pipelineArr, limit });

    const aggParams: QueryParams = { database: targetDb, collection, filter: {}, projection: {}, pipeline: pipelineArr };
    if (requestId) queryParamsStore.set(requestId, aggParams);
    queryParamsStore.set('__latest__', aggParams);

    return res.json(body);
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
  const { requestId, sessionId, messageId } = req.body;
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
      const exportPipeline: Document[] = withSensitiveFieldsUnset(pipelineWithoutTerminalLimit(pipeline));
      docs = await db
        .collection(collection)
        .aggregate(convertOid(exportPipeline) as Document[], { maxTimeMS: DB_TIMEOUT_MS })
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

    // ADR 0003: 세션 지정 시 서버 측 xlsx 생성·저장 → downloadUrl 로 응답.
    // 세션 미지정 (스탠드얼론 호출) 은 레거시 호환 — raw data 를 반환해 호출자 측 생성.
    if (sessionId) {
      try {
        const gen = historyDb.generateAndSaveXlsx(
          sessionId,
          messageId ?? null,
          docs as Record<string, unknown>[],
          JSON.stringify({ collection, filter, projection, sort, pipeline }),
        );
        return res.json({
          exportId: gen.exportId,
          downloadUrl: `/exports/${gen.exportId}/download`,
          fileName: gen.fileName,
          fileSize: gen.fileSize,
          rowCount: gen.rowCount,
          count: docs.length,
          collection,
        });
      } catch (e) {
        return handleHistoryError(res, e);
      }
    }

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

// ADR 0002: 직전 N 턴(user+assistant 쌍) 메타만 LLM 프롬프트에 prepend.
// 데이터 행은 포함 금지. 홀로 남은 user(짝 assistant 없음)는 그대로 포함.
const RECENT_TURNS: number = 5;
const RECENT_MESSAGE_LIMIT: number = RECENT_TURNS * 2;

function buildRecentContext(sessionId: string): string {
  const recent = historyDb.getRecentMessages(sessionId, RECENT_MESSAGE_LIMIT);
  if (recent.length === 0) return '';

  const lines: string[] = ['[최근 대화 기록]'];
  for (const m of recent) {
    if (m.role === 'user') {
      lines.push(`User: ${m.text}`);
      continue;
    }
    if (m.generatedQuery) lines.push(`Query: ${m.generatedQuery}`);
    const att = (m.attachments ?? {}) as Partial<AssistantAttachments>;
    const colsText: string = Array.isArray(att.columns) ? JSON.stringify(att.columns) : '[]';
    const rc: number = typeof att.rowCount === 'number' ? att.rowCount : 0;
    lines.push(`Result: ${rc} rows, columns: ${colsText}`);
    if (m.text) lines.push(`Assistant: ${m.text}`);
  }
  lines.push('[최근 대화 기록 끝]');
  return lines.join('\n');
}

app.post('/chat', (req: Request<object, object, ChatBody>, res: Response) => {
  const { message, requestId, limit = 20, sessionId } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: '메시지를 입력해 주세요.' });
  }

  // ADR 0002: 세션 지정 시에만 recent context 조립 + user 메시지 영속화.
  let recentContext = '';
  if (sessionId !== undefined) {
    try {
      recentContext = buildRecentContext(sessionId);
      historyDb.insertMessage(sessionId, { role: 'user', text: message.trim() });
    } catch (e) {
      return handleHistoryError(res, e);
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send: SendFn = (type: SseEventType, msg: unknown): void => {
    const payload = typeof msg === 'string'
      ? { type, message: msg }
      : { type, data: msg };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[요청] ${message.trim()}`);
  console.log(`${'─'.repeat(60)}`);

  // agy 인자:
  // - --sandbox: terminal restrictions 활성화 (LLM 이 shell 명령을 실제로 실행하지 못하게).
  // - --dangerously-skip-permissions 를 반드시 넣지 말 것 (이 flag 가 도구 자동 승인이므로 정반대).
  // - --output-format stream-json: 최종 응답을 result 이벤트 (result.response) 로 받는다.
  // - --print-timeout: 응답 대기 시간 제한.
  const child: ChildProcess = spawn(
    resolveAgyCli(),
    [
      '-p', buildGeminiPrompt(message.trim(), limit, recentContext),
      '--output-format', 'stream-json',
      '--model', GEMINI_MODEL,
      '--sandbox',
      '--print-timeout', GEMINI_PRINT_TIMEOUT,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: AGY_CHILD_ENV, cwd: CLI_WORKDIR }
  );

  if (requestId) activeJobs.set(requestId, child);

  const handleAgyEvent = createAgyEventHandler(send);
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
        const event: AgyEvent = JSON.parse(line) as AgyEvent;
        handleAgyEvent(event);
        if (event.event === 'result' && event.result?.status === 'SUCCESS') {
          finalResult = event.result.response ?? '';
        }
      } catch { /* 파싱 불가 라인 무시 */ }
    }
  });

  child.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });

  child.on('close', async (code: number | null, signal: NodeJS.Signals | null) => {
    if (requestId) activeJobs.delete(requestId);

    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      send('cancelled', '조회가 중지되었습니다.');
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`${'─'.repeat(60)}\n`);
      return;
    }

    if (code !== 0 && !finalResult) {
      console.error('[오류] agy 프로세스 실패 (exit code:', code, ')');
      console.error(stderr);
      send('error',
        code === null
          ? 'agy 프로세스가 응답하지 않았습니다.'
          : 'agy 프로세스 실행 실패: ' + stderr.slice(0, 200)
      );
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`${'─'.repeat(60)}\n`);
      return;
    }

    // LLM 이 뱉은 텍스트에서 JSON 추출 → 서버가 직접 실행 → SSE 로 브라우저에 결과 전송.
    const parsed = extractJsonFromText(finalResult);
    if (!isLlmQueryPayload(parsed)) {
      console.error(`[오류] agy 출력에서 유효한 쿼리 JSON 을 찾지 못함. 원문 앞머리: ${finalResult.slice(0, 200)}`);
      send('error', 'agy 가 쿼리 JSON 을 만들지 못했습니다. 다시 시도해 주세요.');
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`${'─'.repeat(60)}\n`);
      return;
    }

    const endpoint: '/db-query' | '/db-aggregate' = parsed.kind === 'aggregate' ? '/db-aggregate' : '/db-query';
    send('query', { endpoint, requestBody: parsed as unknown as Record<string, unknown> } satisfies QueryEventPayload);
    send('log', JSON.stringify(parsed));
    send('progress', `조회 시작 — DB ${parsed.kind === 'aggregate' ? '집계' : '쿼리'} 실행 중...`);
    console.log(`${ts()} [조회 시작]  ${endpoint}`);
    console.log(`             ${JSON.stringify(parsed)}`);

    let assistantAttachments: AssistantAttachments | null = null;
    let dataForPromotion: Document[] | null = null;
    try {
      if (parsed.kind === 'query') {
        if (!parsed.collection) throw new Error('collection 필드 누락');
        const filter: Document = parsed.filter ?? {};
        const projection: Projection = parsed.projection ?? {};
        const targetDb: string = DB_DATABASE!;
        const { body, effectiveFilter } = await executeQueryInternal({
          database: targetDb,
          collection: parsed.collection,
          filter,
          projection,
          sort: parsed.sort,
          limit: parsed.limit ?? limit,
        });
        if (requestId) {
          const qp: QueryParams = { database: targetDb, collection: parsed.collection, filter: effectiveFilter, projection, sort: parsed.sort };
          queryParamsStore.set(requestId, qp);
          queryParamsStore.set('__latest__', qp);
        }
        send('result-data', body as unknown as ResultDataEventPayload);
        send('progress', `DB 응답 완료 — ${body.count}건 / ${(body.dbTimeMs / 1000).toFixed(2)}초`);
        assistantAttachments = { columns: body.columns, rowCount: body.count };
        dataForPromotion = body.data;
      } else {
        if (!parsed.collection) throw new Error('collection 필드 누락');
        if (!Array.isArray(parsed.pipeline) || parsed.pipeline.length === 0) throw new Error('pipeline 배열 누락');
        const targetDb: string = DB_DATABASE!;
        const { body } = await executeAggregateInternal({
          database: targetDb,
          collection: parsed.collection,
          pipeline: parsed.pipeline,
          limit: parsed.limit ?? limit,
        });
        if (requestId) {
          const qp: QueryParams = { database: targetDb, collection: parsed.collection, filter: {}, projection: {}, pipeline: parsed.pipeline };
          queryParamsStore.set(requestId, qp);
          queryParamsStore.set('__latest__', qp);
        }
        send('result-data', body as unknown as ResultDataEventPayload);
        send('progress', `DB 응답 완료 — ${body.count}건 / ${(body.dbTimeMs / 1000).toFixed(2)}초`);
        assistantAttachments = { columns: body.columns, rowCount: body.count };
        dataForPromotion = body.data;
      }
      send('result', '');

      // ADR 0002: assistant 메시지 저장 (data 미포함 메타만).
      // ADR 0001: data 가 10MB 상한 초과 시 자동 Export 승격 → attachments 를 table-ref 로 전환.
      if (sessionId && assistantAttachments) {
        try {
          const assistantMessageId = historyDb.insertMessage(sessionId, {
            role: 'assistant',
            text: '',
            generatedQuery: JSON.stringify(parsed),
            attachments: assistantAttachments,
          });
          send('assistant-saved', { messageId: assistantMessageId });

          const dataByteSize = dataForPromotion && dataForPromotion.length > 0
            ? Buffer.byteLength(JSON.stringify(dataForPromotion))
            : 0;
          if (dataForPromotion && historyDb.shouldPromoteToExport(dataByteSize)) {
            try {
              const gen = historyDb.generateAndSaveXlsx(
                sessionId,
                assistantMessageId,
                dataForPromotion as Record<string, unknown>[],
                JSON.stringify(parsed),
              );
              const promoted: PromotedAttachmentRef = {
                type: 'table-ref',
                exportId: gen.exportId,
                columns: assistantAttachments.columns,
                rowCount: assistantAttachments.rowCount,
                promotedReason: PROMOTED_REASON_SIZE_CAP,
              };
              historyDb.updateMessageAttachments(assistantMessageId, promoted);
              send('export-promoted', {
                messageId: assistantMessageId,
                exportId: gen.exportId,
                fileName: gen.fileName,
                fileSize: gen.fileSize,
                rowCount: gen.rowCount,
              });
            } catch (e) {
              console.error('[history-db] Export 승격 실패:', e);
            }
          }
        } catch (e) {
          console.error('[history-db] assistant 메시지 저장 실패:', e);
        }
      }
    } catch (err) {
      const msg: string = isTimeoutError(err) ? DB_TIMEOUT_MSG : (err as Error).message;
      console.error(`[DB 오류] ${msg}`);
      send('error', `DB 오류 — ${msg}`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
    console.log(`${'─'.repeat(60)}\n`);
  });

  child.on('error', (err: NodeJS.ErrnoException) => {
    send(
      'error',
      err.code === 'ENOENT'
        ? 'Antigravity CLI(agy)가 설치되어 있지 않습니다. brew install --cask antigravity-cli 후 재시도하세요.'
        : err.message
    );
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

// ── Session · Message · Export 엔드포인트 ────────────────────────────────────

interface SessionCreateBody { firstQuery?: unknown }
interface SessionRenameBody { title?: unknown }
interface MessageCreateBody {
  role?: unknown;
  text?: unknown;
  generatedQuery?: unknown;
  attachments?: unknown;
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function handleHistoryError(res: Response, e: unknown): void {
  if (e instanceof HistoryDbValidationError) {
    sendError(res, 400, e.message);
    return;
  }
  console.error('[history-db]', e);
  sendError(res, 500, e instanceof Error ? e.message : String(e));
}

app.get('/sessions', (_req: Request, res: Response) => {
  res.json(historyDb.listSessions());
});

app.post('/sessions', (req: Request<object, object, SessionCreateBody>, res: Response) => {
  const firstQuery = typeof req.body.firstQuery === 'string' ? req.body.firstQuery : '';
  const session = historyDb.createSession(firstQuery);
  res.status(201).json(session);
});

app.patch('/sessions/:id', (req: Request<{ id: string }, object, SessionRenameBody>, res: Response) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!title) {
    sendError(res, 400, 'title 은 비어있을 수 없습니다');
    return;
  }
  try {
    historyDb.renameSession(req.params.id, title);
    res.status(204).end();
  } catch (e) {
    handleHistoryError(res, e);
  }
});

app.delete('/sessions/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    historyDb.deleteSession(req.params.id);
    res.status(204).end();
  } catch (e) {
    handleHistoryError(res, e);
  }
});

app.get('/sessions/:id/messages', (req: Request<{ id: string }>, res: Response) => {
  try {
    res.json(historyDb.listMessages(req.params.id));
  } catch (e) {
    handleHistoryError(res, e);
  }
});

app.post('/sessions/:id/messages', (req: Request<{ id: string }, object, MessageCreateBody>, res: Response) => {
  const { role, text, generatedQuery, attachments } = req.body;
  if (role !== 'user' && role !== 'assistant') {
    sendError(res, 400, 'role 은 user 또는 assistant 여야 합니다');
    return;
  }
  if (typeof text !== 'string') {
    sendError(res, 400, 'text 는 문자열이어야 합니다');
    return;
  }
  let generatedQueryValue: string | null | undefined;
  if (typeof generatedQuery === 'string') generatedQueryValue = generatedQuery;
  else if (generatedQuery === null) generatedQueryValue = null;
  else generatedQueryValue = undefined;
  try {
    const messageId = historyDb.insertMessage(req.params.id, {
      role,
      text,
      generatedQuery: generatedQueryValue,
      attachments,
    });
    res.status(201).json({ id: messageId });
  } catch (e) {
    handleHistoryError(res, e);
  }
});

app.get('/sessions/:id/exports', (req: Request<{ id: string }>, res: Response) => {
  try {
    res.json(historyDb.listExports(req.params.id));
  } catch (e) {
    handleHistoryError(res, e);
  }
});

app.get('/exports/:id/download', (req: Request<{ id: string }>, res: Response) => {
  let exp;
  try {
    exp = historyDb.getExport(req.params.id);
  } catch (e) {
    handleHistoryError(res, e);
    return;
  }
  if (!exp) {
    sendError(res, 404, 'export not found');
    return;
  }
  const abs = path.resolve(import.meta.dirname, exp.filePath);
  res.download(abs, exp.fileName, (err): void => {
    if (!err) return;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      try { historyDb.deleteExport(req.params.id); } catch { /* 레코드 정리 실패해도 404 유지 */ }
      if (!res.headersSent) sendError(res, 404, 'file not found');
      return;
    }
    if (!res.headersSent) sendError(res, 500, '파일 전송 실패');
  });
});

app.delete('/exports/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    historyDb.deleteExport(req.params.id);
    res.status(204).end();
  } catch (e) {
    handleHistoryError(res, e);
  }
});

mongoClient
  .connect()
  .then((): void => {
    console.log(`MongoDB 연결 완료: ${DB_HOST}:${DB_PORT}/${DB_DATABASE}`);
    const server: Server = app.listen(Number(PORT), (): void => {
      console.log(`서버 실행 중: http://localhost:${PORT}`);
      setImmediate((): void => {
        const orphans = historyDb.cleanupOrphans();
        if (orphans.orphanFiles > 0 || orphans.orphanRecords > 0) {
          console.log(
            `[history-db] 고아 정리: files=${orphans.orphanFiles} records=${orphans.orphanRecords}`,
          );
        }
      });
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

async function shutdown(): Promise<void> {
  historyDb.close();
  await mongoClient.close();
  console.log('MongoDB 커넥션 종료');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
