import 'dotenv/config';
import express, { Request, Response, Application } from 'express';
import { spawn, execSync, ChildProcess } from 'child_process';
import { MongoClient, ObjectId, Decimal128, Document, Filter, Sort, Db, FindCursor, WithId } from 'mongodb';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { loadAllSchemas } from './scripts/load-schema-index.js';
import { analyzePipeline } from './scripts/pipeline-analyze.js';
import { buildColumnsFromQuery, buildColumnsFromPipeline } from './scripts/build-columns.js';

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

// Claude 자식 프로세스에 상속시키지 않을 민감 키
// Why: LLM 이 spawn 된 프로세스의 env 를 통해 자격 증명을 유출하지 못하게 차단
const CLAUDE_CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const SENSITIVE_KEYS: readonly string[] = [
    'DB_HOST', 'DB_PORT', 'DB_DATABASE',
    'DB_USER_NAME', 'DB_USER_PASSWORD',
  ];
  for (const key of SENSITIVE_KEYS) delete env[key];
  return env;
})();

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

type SseEventType = 'progress' | 'log' | 'query' | 'result-data' | 'result' | 'error' | 'cancelled';
type SendFn = (type: SseEventType, msg: unknown) => void;

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

function buildSystemPrompt(requestId: string, limit: number = 20): string {
  return `MongoDB 조회 어시스턴트. 사용자 질문을 curl 로 쿼리 실행 후 즉시 종료한다.

**절대 규칙**: 쿼리가 성공하면 어떤 텍스트도 만들지 마라. "조회되었습니다", "N건 나왔습니다", "결과입니다" 같은 확인 메시지도 금지. 서버가 UI 로 표를 직접 그린다. 요약도 나열도 인사말도 필요 없다.

**허용되는 텍스트 응답**:
- 쿼리 전 사용자 사전 확인 (예: transactions 요약/로우 선택)
- 쿼리 오류 시 짧은 원인 (예: "collection 필드 누락")

쿼리가 성공한 turn 은 반드시 아무 텍스트 없이 종료.

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
- 필드 네이밍 규약 — 접미사 \`Idx\` = String, \`Obj\` = ObjectId. \`Idx\` 필드는 절대 {"$oid":"..."} 로 감싸지 말고 문자열로 그대로 전달. \`Obj\` 필드는 {"$oid":"..."} 로 감싼다. "환자식별자"·"사용자ID" 같이 모호한 표현은 반드시 컬렉션 스키마를 확인해 정확한 필드명(예: patientObj vs patientIdx) 을 고른 뒤 그에 맞는 타입으로 전달
- 단순 필터·정렬·필드 선택은 /db-query 사용, $group·$lookup·$unwind·계산 필드가 필요할 때만 /db-aggregate 사용
- 집계는 가능한 한 초반에 $match를 두고, 반환 필드 제한은 마지막 $project 또는 $unset으로 처리한다
- $lookup 사용 시 반드시 $group으로 중복 제거 (1:N 조인 시 중복 발생)
- $lookup 대상은 같은 database의 컬렉션만 가능하며, 조인 대상 foreignField에 맞는 필드 타입(ObjectId/Number/String)을 확인한다
- $group에서 조인 대상 필드는 $first로 전체 수집 후 $replaceRoot로 루트 교체 — 필드를 개별 나열하지 말 것
- /db-query 의 limit 필드 및 /db-aggregate 파이프라인 마지막 stage는 반드시 { "$limit": ${limit} } 로 명시한다. aggregate 에서 $limit 누락 시 서버가 강제 주입
- 응답은 rows 를 포함하지 않는 meta({count, dbTimeMs, columnConfidence, unmappedKeys}) 만 반환된다. 서버가 UI 로 직접 표를 스트림하므로 결과 나열 금지
- 오류 발생 시 짧게 원인만 전달 (예: "collection 필드 누락"). 정상 응답이면 아무 말도 하지 말고 종료
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

// Chat 컨텍스트에서 온 요청이면 rows 를 브라우저로 SSE 스트림하고 Claude 에는 meta 만 돌려준다.
// - UI 는 SSE 로 원본을 받는다 (전체 rows 는 브라우저까지 직결이므로 크기 상한 없음).
// - Claude 가 보는 curl 응답은 rows·columns 를 제거한 meta 로 대체.
// non-chat(직접 curl 호출 등) 요청은 원본 body 그대로 반환.
function splitForChatContext(
  requestId: string | undefined,
  fullBody: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!requestId) return null;
  const send = chatSends.get(requestId);
  if (!send) return null;

  send('result-data', fullBody as unknown as ResultDataEventPayload);

  // Claude 가 보는 meta: count/dbTimeMs/columnConfidence/unmappedKeys/message/autoLimitedTo/retried 만 유지
  const { data: _data, columns: _columns, ...meta } = fullBody as Record<string, unknown> & {
    data?: unknown;
    columns?: unknown;
  };
  return meta;
}

// ── 문자열↔숫자 자동 재쿼리 ───────────────────────────────────────────────────
// 사용자가 "01012345678" 같은 문자열로 검색했는데 실제로는 숫자로 저장되어 있을 때 대응.
// count === 0 이면 filter 트리에서 숫자 형태의 문자열을 찾아 Number 로 변환 후 1회 재시도.
// LLM 이 결과를 안 보므로 이 로직이 서버에 있어야 재시도가 결정론적으로 일어난다.
const NUMERIC_STRING_REGEX = /^0?\d+$/;

// Extended JSON atomic marker / meta 연산자 — 이 키를 만나면 하위 값은 그대로 둔다.
// $in·$eq·$and 등 사용자 값이 들어가는 연산자는 계속 재귀.
const NO_RECURSE_OPS = new Set([
  '$oid', '$date', '$numberDecimal', '$numberLong', '$binary', '$timestamp',
  '$regex', '$options', '$type', '$exists', '$size', '$mod',
]);

const OID_HEX_REGEX_FULL = /^[0-9a-fA-F]{24}$/;

function isHex(v: unknown): v is string {
  return typeof v === 'string' && OID_HEX_REGEX_FULL.test(v);
}

// xxxIdx(string) 값을 xxxObj(ObjectId) 로 rename + wrap 시도.
// - `{keyIdx: "hex24"}` → `{keyObj: {$oid: "hex24"}}`
// - `{keyIdx: {$eq: "hex24"}}` → `{keyObj: {$oid: "hex24"}}`
// - `{keyIdx: {$in: ["hex", ...]}}` → `{keyObj: {$in: [{$oid:"hex"},...]}}`
// - `{keyIdx: {$oid: "hex24"}}` → `{keyObj: {$oid: "hex24"}}` (LLM 이 Idx 를 실수로 $oid 로 감싼 케이스)
// 스키마 상 Idx 로 나와있어 LLM 이 string 으로 쿼리했지만 실제 DB 는 Obj 로 저장된 경우, 또는
// LLM 이 Idx 필드에 $oid 를 잘못 붙인 경우(Idx=String 이므로 타입 불일치) 대응.
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

// 변환 대상: 6자리 이상 && 숫자만 구성된 문자열. 전화번호·사번·주민등록번호 등 커버.
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

// ── Claude 이벤트 핸들러 ──────────────────────────────────────────────────────

function createClaudeEventHandler(send: SendFn): (event: ClaudeEvent) => void {
  let systemSeen: boolean = false;

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

        if (hasToolUse) {
          for (const block of contents) {
            if (block.type !== 'tool_use' || block.name !== 'Bash') continue;
            const cmd: string = block.input?.command?.trim() ?? '';
            if (cmd.includes('/db-query') || cmd.includes('/db-aggregate')) {
              const isAgg: boolean = cmd.includes('/db-aggregate');
              const endpoint: '/db-query' | '/db-aggregate' = isAgg ? '/db-aggregate' : '/db-query';
              console.log(`${ts()} [조회 시작]  DB ${isAgg ? '집계' : '쿼리'} 실행 중...`);
              console.log(`             $ ${cmd}`);
              send('progress', `조회 시작 — DB ${isAgg ? '집계' : '쿼리'} 실행 중...`);
              const singleMatch: RegExpMatchArray | null = cmd.match(/-d\s+'([^']+)'/);
              const doubleMatch: RegExpMatchArray | null = cmd.match(/-d\s+"((?:[^"\\]|\\.)*)"/);
              const rawData: string | undefined = singleMatch?.[1] ?? doubleMatch?.[1]?.replace(/\\"/g, '"');
              if (rawData) {
                try {
                  const parsedBody = JSON.parse(rawData) as Record<string, unknown>;
                  // 구조화된 query 이벤트 — UI 가 파이프라인/필터 상세를 파싱해 사용할 수 있음
                  send('query', { endpoint, requestBody: parsedBody } satisfies QueryEventPayload);
                  // 공백 없는 압축 JSON — 사용자가 UI 로그에서 그대로 복사해 쿼리 에디터로 검증 가능하도록.
                  send('log', JSON.stringify(parsedBody));
                } catch {
                  const collMatch: RegExpMatchArray | null = rawData.match(/["']collection["']\s*:\s*["']([^"']+)["']/);
                  send('log', collMatch ? `collection: ${collMatch[1]}` : rawData);
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
        }
        // LLM 이 tool_result 이후 text 를 만들면(예: transactions 사전 확인 대화·오류 설명) 그대로 finalResult 로 흘러가 result 이벤트로 전달됨.
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
  };
}

// ── Express 앱 ────────────────────────────────────────────────────────────────

const app: Application = express();
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, 'public')));

const activeJobs: Map<string, ChildProcess> = new Map();
const queryParamsStore: Map<string, QueryParams> = new Map();
// requestId → SSE sender bound to an active /chat stream.
// /db-query·/db-aggregate 는 chatSends 에 등록된 요청이면 rows 를 브라우저로 직접 스트림하고
// curl 응답(=Claude 가 보는 tool_result) 에서 rows 를 뺀 meta 만 반환한다.
const chatSends: Map<string, SendFn> = new Map();

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
    let effectiveFilter: Document = filter;
    let convertedFilter = convertOid(filter) as Filter<Document>;
    let retried: 'stringToNumber' | 'idxToObj' | undefined;

    const dbStart: number = Date.now();

    // Step 1: 전체 건수 확인
    let totalCount: number = await db.collection(collection).countDocuments(convertedFilter, { maxTimeMS: DB_TIMEOUT_MS });

    // Step 1.5: 0건이면 몇 가지 자동 재쿼리 시도 (LLM 이 결과를 안 보므로 서버가 대응).
    // (a) 숫자 형태의 문자열 → Number : "01012345678" → 1012345678
    // (b) xxxIdx string → xxxObj ObjectId : {creatorIdx:"6929..."} → {creatorObj:{$oid:"6929..."}}
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
      const body = {
        count: 0,
        data: [],
        dbTimeMs,
        message: '조회된 데이터가 없습니다.',
        ...emptyCols,
      };
      const meta = splitForChatContext(requestId, body);
      return res.json(meta ?? body);
    }

    // Step 2: 건수 기반 limit 적용하여 본 쿼리 실행
    let cursor: FindCursor<WithId<Document>> = db
      .collection(collection)
      .find(convertedFilter, { projection: convertOid(projection) as Document })
      .maxTimeMS(DB_TIMEOUT_MS);
    if (sort) cursor = cursor.sort(sort);
    const docs: WithId<Document>[] = await cursor.limit(limit).toArray();
    const dbTimeMs: number = Date.now() - dbStart;

    // 재시도로 필터가 바뀌었다면 내보내기용 저장 파라미터도 새 필터로 갱신
    if (retried && requestId) {
      const updated: QueryParams = { database: targetDb, collection, filter: effectiveFilter, projection, sort };
      queryParamsStore.set(requestId, updated);
      queryParamsStore.set('__latest__', updated);
    }

    const cols = buildColumnsFromQuery(collection, docs, projection);
    const fullBody: Record<string, unknown> = { count: totalCount, data: docs, dbTimeMs, ...cols };
    if (retried) fullBody.retried = retried;
    const meta = splitForChatContext(requestId, fullBody);
    return res.json(meta ?? fullBody);
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

    // terminal $limit 이 없으면 서버가 강제 주입 — 브라우저·DB 부하 방어용 안전장치
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

    // 내보내기 재실행을 위해 원본(주입 전) pipeline을 저장
    const aggParams: QueryParams = { database: targetDb, collection, filter: {}, projection: {}, pipeline: pipelineArr };
    if (requestId) queryParamsStore.set(requestId, aggParams);
    queryParamsStore.set('__latest__', aggParams);

    const analysis = analyzePipeline(collection, pipelineArr);

    if (totalCount === 0) {
      const emptyCols = buildColumnsFromPipeline(collection, [], analysis);
      const emptyBody = {
        count: 0,
        data: [],
        dbTimeMs,
        message: '조회된 데이터가 없습니다.',
        ...emptyCols,
      };
      const meta = splitForChatContext(requestId, emptyBody);
      return res.json(meta ?? emptyBody);
    }
    const cols = buildColumnsFromPipeline(collection, docs, analysis);
    const body: Record<string, unknown> = { count: totalCount, data: docs, dbTimeMs, ...cols };
    if (autoLimited) body.autoLimitedTo = limit;
    const meta = splitForChatContext(requestId, body);
    return res.json(meta ?? body);
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

  // result-data 를 한 번이라도 흘렸다면 LLM 이 마지막에 짧은 요약("N건 조회되었습니다") 을 만들어도 억제한다.
  // 데이터 요약은 UI 표가 담당 — 최종 result 이벤트는 사전 확인 대화나 오류 설명 용도로만 쓴다.
  let resultDataSent = false;

  const send: SendFn = (type: SseEventType, msg: unknown): void => {
    if (type === 'result-data') resultDataSent = true;
    const payload = typeof msg === 'string'
      ? { type, message: msg }
      : { type, data: msg };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  if (requestId) chatSends.set(requestId, send);

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
    { stdio: ['ignore', 'pipe', 'pipe'], env: CLAUDE_CHILD_ENV }
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
    if (requestId) {
      activeJobs.delete(requestId);
      chatSends.delete(requestId);
    }
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      send('cancelled', '조회가 중지되었습니다.');
    } else if (code !== 0 && !finalResult) {
      console.error('[오류] Claude 프로세스 실패 (exit code:', code, ')');
      console.error(stderr);
      send('error', 'Claude 프로세스 실행 실패: ' + stderr.slice(0, 200));
    } else {
      // 쿼리가 성공적으로 실행되어 rows 를 UI 로 흘렸다면 LLM 텍스트는 억제.
      const outText: string = resultDataSent ? '' : finalResult.trim();
      send('result', outText);
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
