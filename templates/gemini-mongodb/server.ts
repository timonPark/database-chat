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
const GEMINI_MODEL: string = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash-medium';
const GEMINI_PRINT_TIMEOUT: string = process.env.GEMINI_PRINT_TIMEOUT?.trim() || '5m';
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
  limit?: number;
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

// agy stream-json 이벤트 (실제 관측된 shape, `agy --output-format stream-json` v1.2.5)
interface AgyInitEvent {
  event: 'init';
  init?: { model?: string; permission_mode?: string };
}

type AgyStepType = 'user_input' | 'agent_response' | 'tool';
type AgyStepState = 'ACTIVE' | 'DONE';

interface AgyToolInfo {
  name?: string;
  parameters?: Record<string, unknown> & { CommandLine?: string };
  output?: string;
}

interface AgyStepUpdate {
  step_index?: number;
  state?: AgyStepState;
  step_type?: AgyStepType;
  text_delta?: string;
  tool_name?: string;
  tool_info?: AgyToolInfo;
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
- MongoDB 연산자는 반드시 $로 시작한다: $regex, $options, $in, $lt, $gte, $exists, $ne 등. "options"/"regex" 처럼 $ 누락 절대 금지 (MongoDB가 unknown operator 오류 반환)
- 대소문자 무시 검색은 {"$regex":"...","$options":"i"} 형태로 작성한다 (JSON 페이로드는 /pattern/i 리터럴을 못 씀)
- 단순 필터·정렬·필드 선택은 /db-query 사용, $group·$lookup·$unwind·계산 필드가 필요할 때만 /db-aggregate 사용
- 집계는 가능한 한 초반에 $match를 두고, 반환 필드 제한은 마지막 $project 또는 $unset으로 처리한다
- $lookup은 항상 좌측 외부 조인이며 결과는 배열(as 필드)로 반환된다
- $lookup 대상은 같은 database의 컬렉션만 가능하며, 조인 대상 foreignField에 맞는 필드 타입(ObjectId/Number/String)을 확인한다
- 조인 방향에 따라 중복 처리:
  · 좌측 1건 : 우측 N건 (예: movie→comments) — 중복 방지 위해 $unwind 후 $group + $first + $replaceRoot 로 재구성
  · 좌측 N건 : 우측 1건 (예: comments→user) — 중복 없음. $unwind만 하고 $group·$replaceRoot 사용 금지 (파이프라인만 무거워짐)
- /db-query 의 limit 필드 및 /db-aggregate 파이프라인 마지막 stage는 반드시 { "$limit": ${limit} } 로 명시한다. aggregate 에서 $limit 누락 시 서버가 강제 주입하며 응답에 autoLimitedTo 필드가 포함됨 — 그 경우 재쿼리 금지하고 반환된 상위 ${limit}건으로 즉시 응답한다. 엑셀 내보내기는 원본 파이프라인 그대로 재실행함
- 응답 JSON에 truncatedTo 필드가 있으면 LLM tool 출력 한도로 서버가 상위 truncatedTo건만 전송한 상태다. 재쿼리·python/wc 우회·재시도 모두 금지, 반환된 data 배열 그대로 사용자에게 응답한다. 더 많은 필드/건수가 필요하면 다음 요청에서 $project로 필드를 줄이거나 limit을 낮춰 재요청한다
- 숫자로도 문자열로도 저장 가능한 값(전화번호·사번·주민등록번호 등)은 우선 값 그대로 조회한 뒤 결과가 0건이면 타입을 반대로 바꿔 한 번 더 재시도한다. 예) "01012345678"로 검색해 0건이면 즉시 숫자 01012345678(선행 0 제거된 정수)로 재조회. 재조회에서도 0건이면 "조회된 데이터가 없습니다"
- 결과 없으면 즉시 "조회된 데이터가 없습니다"
- 출력이 파일로 저장되면 파일 읽지 말고 $group으로 줄여 재쿼리
- 오류 시 원인 설명
- 필드·스키마 확인은 반드시 cat "${COLLECTIONS_DIR}/<컬렉션명>.md" 로만 한다. 실 DB 쿼리로 정찰하지 말 것
- 조인·집계 필요 시 사전 count 쿼리 없이 곧바로 /db-aggregate 를 호출한다. 규모 파악용 추가 쿼리 금지
- 첫 쿼리가 성공했으면 결과를 그대로 사용해 응답한다. 검증·refinement 목적의 재호출 금지
- 결과가 나오면 즉시 응답한다. 불필요한 재시도·사고 과정 노출 금지
- 거래 내역(transactions) 조회 요청 시 쿼리 실행 전에 반드시 먼저 물어본다: "요약(계좌별 거래 건수 합계)으로 보시겠어요, 아니면 개별 거래 건 단위(로우)로 보시겠어요?" — 사용자가 답하면 그에 맞게 쿼리한다`;
}

function buildGeminiPrompt(message: string, requestId: string, limit: number = 20): string {
  return `${buildSystemPrompt(requestId, limit)}

[사용자 질문]
${message}`;
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

// LLM tool 출력 한도(agy ~8213B, 여유 마진 포함)에 맞춰 응답 body를 자동 축약.
// data 배열 앞에서부터 items를 채우다가 한도를 넘기 직전에 자른다.
const TOOL_OUTPUT_MAX_BYTES: number = 6500;

function capForToolOutput(body: Record<string, unknown>, maxBytes: number = TOOL_OUTPUT_MAX_BYTES): Record<string, unknown> {
  const data = body.data;
  if (!Array.isArray(data) || data.length === 0) return body;
  const wrapper: Record<string, unknown> = { ...body, data: [] };
  const wrapperSize: number = Buffer.byteLength(JSON.stringify(wrapper), 'utf8');
  let usedBytes: number = wrapperSize;
  let kept: number = 0;
  for (const item of data) {
    const itemBytes: number = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1; // + comma
    if (usedBytes + itemBytes > maxBytes) break;
    usedBytes += itemBytes;
    kept++;
  }
  if (kept >= data.length) return body;
  const originalCount: number = data.length;
  return {
    ...body,
    data: data.slice(0, kept),
    truncatedTo: kept,
    truncatedFrom: originalCount,
    hint: `LLM tool 출력 한도(약 8KB) 대응: 요청한 ${originalCount}건 중 상위 ${kept}건만 전송. 재쿼리·재실행 금지. 이 결과 그대로 사용자에게 응답하세요. 더 많은 필드가 필요하면 다음 시도에서 $project로 필드를 줄이거나 limit을 낮추세요.`,
  };
}

// ── agy 이벤트 핸들러 ─────────────────────────────────────────────────────────

function summarizeToolCommand(cmd: string, send: SendFn): void {
  if (cmd.includes('/db-query') || cmd.includes('/db-aggregate')) {
    // /db-* 는 서버 endpoint가 sendDbStart/sendDbResult 로 전체 쿼리를 push 하므로 여기선 스킵.
    // agy 가 CommandLine 을 ~500자에서 잘라 전달하기 때문에 여기서 파싱하면 쿼리가 잘림.
    return;
  } else if (cmd.startsWith('cat') && !cmd.includes('|')) {
    const file: string | undefined = cmd.replace('cat', '').trim().split('/').pop();
    console.log(`${ts()} [필드 확인]  ${file} 스키마 읽는 중...`);
    send('progress', `필드 확인 — ${file} 스키마 읽는 중...`);
    send('log', `$ cat ${file}`);
  } else {
    const label: string = cmd.includes('jq') || cmd.includes('python')
      ? '결과 가공 중...'
      : '실행 중...';
    console.log(`${ts()} [실행]      $ ${cmd.slice(0, 80)}`);
    send('progress', label);
    send('log', `$ ${cmd.length > 120 ? cmd.slice(0, 120) + '...' : cmd}`);
  }
}

function summarizeToolOutput(output: string, send: SendFn): void {
  const text: string = output.trim();
  if (!text) return;
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
  } catch {
    /* JSON 아닌 응답(스키마 파일 등) 무시 */
  }
}

function createAgyEventHandler(send: SendFn): (event: AgyEvent) => void {
  let initSeen: boolean = false;
  let responseAnnounced: boolean = false;
  let lastNonResponseStep: AgyStepType | null = null;

  return function handleAgyEvent(event: AgyEvent): void {
    switch (event.event) {
      case 'init':
        if (!initSeen) {
          initSeen = true;
          console.log(`${ts()} [준비]      agy 세션 시작 (model=${event.init?.model ?? '?'})`);
          send('progress', '준비 중...');
        }
        break;

      case 'step_update': {
        const s: AgyStepUpdate = event.step_update;
        if (!s?.step_type) break;

        if (s.step_type === 'tool') {
          const cmd: string = s.tool_info?.parameters?.CommandLine?.toString().trim() ?? '';
          const isDbTool: boolean = cmd.includes('/db-query') || cmd.includes('/db-aggregate');
          if (s.state === 'ACTIVE') {
            if (cmd) summarizeToolCommand(cmd, send);
            lastNonResponseStep = 'tool';
          } else if (s.state === 'DONE' && !isDbTool && s.tool_info?.output) {
            // /db-* 응답은 서버 endpoint 가 sendDbResult 로 이미 push — 중복 방지
            summarizeToolOutput(s.tool_info.output, send);
          }
          responseAnnounced = false;
        } else if (s.step_type === 'agent_response') {
          if (s.state === 'ACTIVE' && !responseAnnounced && lastNonResponseStep === 'tool') {
            responseAnnounced = true;
            console.log(`${ts()} [응답 생성]  응답값 생성 중...`);
            send('progress', '응답값 생성 중...');
          }
        } else if (s.step_type === 'user_input') {
          lastNonResponseStep = 'user_input';
        }
        break;
      }

      case 'result': {
        const status = event.result?.status ?? '';
        const dur: string = event.result?.duration_seconds != null
          ? ` duration=${event.result.duration_seconds.toFixed(2)}s`
          : '';
        if (status === 'SUCCESS') {
          console.log(`${ts()} [응답 완료]${dur}`);
        } else {
          console.log(`${ts()} [실패]      status=${status}${dur}`);
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
const activeSends: Map<string, SendFn> = new Map();

// 공백 없는 압축 JSON — 사용자가 UI 로그에서 그대로 복사해 쿼리 에디터로 검증 가능하도록.
function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function sendDbStart(requestId: string | undefined, mode: '쿼리' | '집계', payload: unknown): void {
  if (!requestId) return;
  const send: SendFn | undefined = activeSends.get(requestId);
  if (!send) return;
  console.log(`${ts()} [조회 시작]  DB ${mode} 실행 중...`);
  console.log(`             ${compactJson(payload)}`);
  send('progress', `조회 시작 — DB ${mode} 실행 중...`);
  send('log', compactJson(payload));
}

function sendDbResult(requestId: string | undefined, count: number, dbTimeMs: number, extra?: string): void {
  if (!requestId) return;
  const send: SendFn | undefined = activeSends.get(requestId);
  if (!send) return;
  const detail: string = `${count}건 수신 / DB실행: ${(dbTimeMs / 1000).toFixed(2)}초${extra ? ` · ${extra}` : ''}`;
  console.log(`${ts()} [DB 응답 확인] ${detail}`);
  send('progress', `DB 응답 확인 — ${detail}`);
}

function sendDbError(requestId: string | undefined, error: string): void {
  if (!requestId) return;
  const send: SendFn | undefined = activeSends.get(requestId);
  if (!send) return;
  console.log(`${ts()} [DB 오류] ${error}`);
  send('progress', `DB 오류 — ${error}`);
}

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
  sendDbStart(requestId, '쿼리', { requestId, database: targetDb, collection, filter, projection, sort, limit });

  try {
    const db: Db = mongoClient.db(targetDb);
    const convertedFilter = convertOid(filter) as Filter<Document>;

    const dbStart: number = Date.now();

    const totalCount: number = await db.collection(collection).countDocuments(convertedFilter, { maxTimeMS: DB_TIMEOUT_MS });

    if (totalCount === 0) {
      const dbTimeMs: number = Date.now() - dbStart;
      sendDbResult(requestId, 0, dbTimeMs);
      return res.json({ count: 0, data: [], dbTimeMs, message: '조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라.' });
    }

    let cursor: FindCursor<WithId<Document>> = db
      .collection(collection)
      .find(convertedFilter, { projection: convertOid(projection) as Document })
      .maxTimeMS(DB_TIMEOUT_MS);
    if (sort) cursor = cursor.sort(sort);
    const docs: WithId<Document>[] = await cursor.limit(limit).toArray();
    const dbTimeMs: number = Date.now() - dbStart;

    sendDbResult(requestId, totalCount, dbTimeMs);
    return res.json(capForToolOutput({ count: totalCount, data: docs, dbTimeMs }));
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(`${ts()} [타임아웃] ${DB_TIMEOUT_MSG} — ${collection}`);
      sendDbError(requestId, DB_TIMEOUT_MSG);
      return res.status(504).json({ error: DB_TIMEOUT_MSG });
    }
    console.error(`[DB 오류] ${(err as Error).message}`);
    sendDbError(requestId, (err as Error).message);
    return res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/db-aggregate', async (req: Request<object, object, DbAggregateBody>, res: Response) => {
  const {
    requestId,
    database,
    collection,
    pipeline = [],
    limit = 20,
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
    sendDbStart(requestId, '집계', { requestId, database: targetDb, collection, pipeline: pipelineArr, limit });

    // terminal $limit이 없으면 서버가 강제 주입 — LLM tool 출력 크기 한도(약 8KB) 초과 방지
    const lastNonProject: Document | undefined = [...pipelineArr].reverse().find((s: Document) => !('$project' in s));
    const hadTerminalLimit: boolean = lastNonProject != null && '$limit' in lastNonProject;
    const effectivePipeline: Document[] = hadTerminalLimit
      ? pipelineArr
      : [...pipelineArr, { $limit: limit }];
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

    // 내보내기 재실행을 위해 원본(주입 전) pipeline을 저장 — 사용자가 export 시 전체 데이터를 받도록
    const aggParams: QueryParams = { database: targetDb, collection, filter: {}, projection: {}, pipeline: pipelineArr };
    if (requestId) queryParamsStore.set(requestId, aggParams);
    queryParamsStore.set('__latest__', aggParams);

    if (totalCount === 0) {
      sendDbResult(requestId, 0, dbTimeMs);
      return res.json({ count: 0, data: [], dbTimeMs, message: '조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라.' });
    }
    sendDbResult(requestId, totalCount, dbTimeMs, autoLimited ? `서버 auto-inject $limit ${limit}` : undefined);
    const body: Record<string, unknown> = { count: totalCount, data: docs, dbTimeMs };
    if (autoLimited) {
      body.autoLimitedTo = limit;
      body.message = `pipeline 끝에 $limit 이 없어 서버가 자동으로 { $limit: ${limit} } 을 부착했습니다. 총 ${totalCount}건 중 상위 ${docs.length}건만 반환. 재쿼리 금지, 이 결과 그대로 사용자에게 응답하세요.`;
    }
    return res.json(capForToolOutput(body));
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(`${ts()} [타임아웃] ${DB_TIMEOUT_MSG} — ${collection}`);
      sendDbError(requestId, DB_TIMEOUT_MSG);
      return res.status(504).json({ error: DB_TIMEOUT_MSG });
    }
    console.error(`[DB 집계 오류] ${(err as Error).message}`);
    sendDbError(requestId, (err as Error).message);
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
  if (requestId) activeSends.set(requestId, send);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[요청] ${message.trim()}`);
  console.log(`${'─'.repeat(60)}`);

  const child: ChildProcess = spawn(
    resolveAgyCli(),
    [
      '-p', buildGeminiPrompt(message.trim(), requestId ?? '', limit),
      '--output-format', 'stream-json',
      '--model', GEMINI_MODEL,
      '--dangerously-skip-permissions',
      '--print-timeout', GEMINI_PRINT_TIMEOUT,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
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

  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (requestId) activeJobs.delete(requestId);
    if (requestId) activeSends.delete(requestId);
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      send('cancelled', '조회가 중지되었습니다.');
    } else if (code !== 0 && !finalResult) {
      console.error('[오류] agy 프로세스 실패 (exit code:', code, ')');
      console.error(stderr);
      send('error', 'agy 프로세스 실행 실패: ' + stderr.slice(0, 200));
    } else {
      send('result', finalResult.trim());
    }
    console.log(`${'─'.repeat(60)}\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  child.on('error', (err: NodeJS.ErrnoException) => {
    if (requestId) activeSends.delete(requestId);
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
