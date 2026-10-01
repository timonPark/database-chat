import 'dotenv/config';
import express, { Request, Response, Application } from 'express';
import { spawn, execSync, ChildProcess } from 'child_process';
import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAllSchemas } from './scripts/load-schema-index.js';
import { analyzeSql } from './scripts/sql-analyze.js';
import { buildColumnsFromSql } from './scripts/build-columns.js';

// ── 환경 변수 ──────────────────────────────────────────────────────────────────

const PORT: string = process.env.PORT ?? '3111';
const DB_HOST: string | undefined = process.env.DB_HOST;
const DB_PORT: string = process.env.DB_PORT ?? '3306';
const DB_DATABASE: string | undefined = process.env.DB_DATABASE;
const DB_USER_NAME: string | undefined = process.env.DB_USER_NAME;
const DB_USER_PASSWORD: string | undefined = process.env.DB_USER_PASSWORD;
const TABLE_MAPPING_FILE: string = process.env.TABLE_MAPPING_FILE ?? './table-mapping.md';
const GEMINI_MODEL: string = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash-medium';
const GEMINI_PRINT_TIMEOUT: string = process.env.GEMINI_PRINT_TIMEOUT?.trim() || '5m';
const TABLE_INDEX_FILE: string = './index.md';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLES_DIR: string = path.resolve(__dirname, 'tables');

// agy 자식 프로세스에 상속시키지 않을 민감 키
const AGY_CHILD_ENV: NodeJS.ProcessEnv = (() => {
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

// ── MySQL 연결 풀 ─────────────────────────────────────────────────────────────

const pool: Pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  database: DB_DATABASE,
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
  connectionLimit: 5,
  timezone: '+00:00',
  connectTimeout: 10_000,
});

// ── 타입 정의 ──────────────────────────────────────────────────────────────────

interface DbQueryBody {
  requestId?: string;
  sql?: string;
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

interface SqlStore {
  sql: string;
  table: string;
}

type SseEventType = 'progress' | 'log' | 'query' | 'result-data' | 'result' | 'error' | 'cancelled';

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
type SendFn = (type: SseEventType, msg: unknown) => void;

interface QueryEventPayload {
  endpoint: '/db-query';
  requestBody: Record<string, unknown>;
}

interface ResultDataEventPayload {
  count: number;
  data: Record<string, unknown>[];
  columns: unknown[];
  columnConfidence: 'full' | 'partial';
  unmappedKeys: string[];
  dbTimeMs: number;
}

// ── 테이블 인덱스 로드 ─────────────────────────────────────────────────────────

let tableIndex: string = '';
let tableUpdatedAt: string = '';

try {
  tableIndex = fs.readFileSync(path.resolve(TABLE_INDEX_FILE), 'utf-8');
  const match: RegExpMatchArray | null = tableIndex.match(/최종 업데이트[：:]\s*(.+)/);
  if (match) tableUpdatedAt = match[1].trim();
} catch {
  console.warn(`테이블 인덱스 파일을 읽을 수 없습니다: ${TABLE_INDEX_FILE}`);
  try {
    tableIndex = fs.readFileSync(path.resolve(TABLE_MAPPING_FILE), 'utf-8');
  } catch {
    console.warn(`테이블 매핑 파일도 읽을 수 없습니다: ${TABLE_MAPPING_FILE}`);
  }
}

const schemaLoadResult = loadAllSchemas(TABLES_DIR);
if (schemaLoadResult.total === 0) {
  console.warn(`테이블 스키마 디렉토리가 비어있거나 없습니다: ${TABLES_DIR} (fallback: 원본 key 노출)`);
} else {
  const failedSuffix = schemaLoadResult.failed > 0 ? ` (실패 ${schemaLoadResult.failed}건)` : '';
  console.log(`테이블 스키마 인덱스 로드 완료: ${schemaLoadResult.loaded}/${schemaLoadResult.total}${failedSuffix}`);
}

function loadTableIndex(): string {
  try {
    const content: string = fs.readFileSync(path.resolve(TABLE_INDEX_FILE), 'utf-8');
    const match: RegExpMatchArray | null = content.match(/최종 업데이트[：:]\s*(.+)/);
    if (match) tableUpdatedAt = match[1].trim();
    return content;
  } catch {
    return tableIndex;
  }
}

function buildTableSummary(): string {
  const lines: string[] = loadTableIndex().split('\n');
  const result: string[] = [];
  for (const line of lines) {
    const match: RegExpMatchArray | null = line.match(/\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/);
    if (match) result.push(`${match[1].trim()} — ${match[2].trim()}`);
  }
  return result.join('\n');
}

function buildTableGuide(): string {
  try {
    const lines: string[] = fs.readFileSync(path.resolve(TABLE_MAPPING_FILE), 'utf-8').split('\n');
    return lines
      .filter((line: string) => line.trim().startsWith('| `'))
      .map((line: string) => line.replace(/\s+/g, ' ').trim())
      .join('\n');
  } catch {
    return '';
  }
}

function buildSystemPrompt(limit: number = 20): string {
  return `MySQL 조회 쿼리 생성기. 사용자 자연어 요청 → **정확히 하나의 JSON 객체** 만 출력하고 종료.

**절대 규칙**:
- 응답은 오직 하나의 JSON 객체. 앞뒤에 설명·인사·마크다운 코드펜스·요약 어떤 것도 붙이지 마라
- 도구 · 명령 실행 없음. curl · bash · cat 등 사용 금지 (sandbox 활성화로 실행이 차단됨)
- 서버가 이 JSON 을 파싱해 DB 를 조회하고 결과를 UI 에 직접 그린다. 너는 결과를 볼 수 없고, 결과를 안내할 필요도 없다

**출력 형식** (하나만):

{"kind":"sql","sql":"SELECT ... FROM ... WHERE ... ORDER BY ... LIMIT ${limit}"}

[테이블]
${buildTableSummary()}

[테이블 선택 가이드: 테이블명 | 자연어 키워드 | 주요 컬럼 | 설명]
${buildTableGuide()}

규칙:
- password · pass_hash · passwd · pwd · secret 컬럼은 반드시 SELECT 에서 제외
- SELECT · EXPLAIN · SHOW · DESCRIBE · DESC 만 허용 (INSERT · UPDATE · DELETE · DROP · ALTER · CREATE · TRUNCATE · REPLACE · MERGE · EXEC · EXECUTE · CALL · GRANT · REVOKE · LOAD DATA · INTO OUTFILE · INTO DUMPFILE 절대 금지)
- LIMIT 은 반드시 ${limit} 로 명시 (누락 시 서버가 강제 부착). 엑셀 내보내기는 저장된 SQL 을 그대로 재실행함
- JOIN 시 alias 는 짧게 (t1, t2 등). SELECT 컬럼 라벨링은 서버가 처리
- 단순 WHERE·ORDER BY 든 JOIN·GROUP BY·서브쿼리·HAVING 이든 동일하게 kind:"sql" 하나로 처리`;
}

function buildGeminiPrompt(message: string, limit: number = 20): string {
  return `${buildSystemPrompt(limit)}

[사용자 질문]
${message}`;
}

// ── SQL 보안 검증 ─────────────────────────────────────────────────────────────

const ALLOWED_SQL_PREFIXES: string[] = ['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC'];
const BLOCKED_SQL_KEYWORDS: RegExp = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|EXEC|EXECUTE|CALL|GRANT|REVOKE|LOAD\s+DATA|INTO\s+OUTFILE|INTO\s+DUMPFILE)\b/i;
const SENSITIVE_COLUMNS: string[] = ['password', 'pass_hash', 'passwd', 'pwd', 'secret'];

function validateSql(sqlStr: string): void {
  const trimmed: string = sqlStr.trim().toUpperCase();
  const isAllowed: boolean = ALLOWED_SQL_PREFIXES.some(prefix => trimmed.startsWith(prefix));
  if (!isAllowed) throw new Error('SELECT · EXPLAIN · SHOW · DESCRIBE · DESC 쿼리만 허용됩니다.');
  if (BLOCKED_SQL_KEYWORDS.test(sqlStr)) throw new Error('허용되지 않는 SQL 키워드가 포함되어 있습니다.');
}

function ensureLimit(sqlStr: string, limit: number): string {
  const upper: string = sqlStr.trim().toUpperCase();
  if (!upper.startsWith('SELECT')) return sqlStr;
  if (upper.includes('LIMIT')) return sqlStr;
  return `${sqlStr} LIMIT ${limit}`;
}

// ── 유틸 ──────────────────────────────────────────────────────────────────────

const ts: () => string = () => new Date().toTimeString().slice(0, 8);
const DB_TIMEOUT_MS: number = 30_000;
const DB_TIMEOUT_MSG: string = 'DB 응답시간 초과 Max 30초';

// Windows: npm 전역 설치 agy 는 .cmd shim 이라 shell:false 로 직접 실행 불가 (ENOENT).
// where agy.cmd 로 shim 위치를 찾고 내부의 agy.exe 상대경로를 파싱해 절대경로를 얻는다.
function resolveAgyBin(): string {
  const envPath = process.env.AGY_CLI_PATH?.trim();
  if (envPath) {
    try { execSync(`"${envPath}" --version`, { stdio: 'ignore' }); return envPath; } catch { /* fallback */ }
  }
  try {
    const shims = execSync('where agy.cmd', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\r?\n/);
    for (const shim of shims) {
      const m = fs.readFileSync(shim.trim(), 'utf-8').match(/%~?dp0%?\\([^\s"]+agy\.exe)/i);
      if (!m) continue;
      const resolved = path.resolve(path.dirname(shim.trim()), m[1]);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch { /* fallback */ }
  return 'agy';
}

function isTimeoutError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === 'PROTOCOL_SEQUENCE_TIMEOUT' || (e.message ?? '').includes('Timeout');
}

// ── 내부 실행 함수 ──────────────────────────────────────────────────────────

interface SqlResultBody {
  count: number;
  data: Record<string, unknown>[];
  dbTimeMs: number;
  columns: unknown[];
  columnConfidence: 'full' | 'partial';
  unmappedKeys: string[];
  message?: string;
}

async function executeSqlInternal(rawSql: string, limit: number): Promise<{ body: SqlResultBody; effectiveSql: string; table: string }> {
  validateSql(rawSql);
  const effectiveSql: string = ensureLimit(rawSql, limit);
  const analysis = analyzeSql(effectiveSql);
  const table: string = analysis.baseTable ?? 'result';

  const dbStart: number = Date.now();
  const [rows] = await pool.query<RowDataPacket[]>({ sql: effectiveSql, timeout: DB_TIMEOUT_MS });
  const dbTimeMs: number = Date.now() - dbStart;

  const data: Record<string, unknown>[] = rows.map((row: RowDataPacket) => {
    const r: Record<string, unknown> = { ...row };
    for (const col of SENSITIVE_COLUMNS) delete r[col];
    return r;
  });

  const cols = buildColumnsFromSql(data, analysis);

  if (data.length === 0) {
    return {
      body: {
        count: 0,
        data: [],
        dbTimeMs,
        message: '조회된 데이터가 없습니다.',
        ...cols,
      },
      effectiveSql,
      table,
    };
  }

  return {
    body: { count: data.length, data, dbTimeMs, ...cols },
    effectiveSql,
    table,
  };
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

interface LlmSqlPayload {
  kind: 'sql';
  sql?: string;
  limit?: number;
}

function isLlmSqlPayload(v: unknown): v is LlmSqlPayload {
  if (v === null || typeof v !== 'object') return false;
  const kind = (v as { kind?: unknown }).kind;
  return kind === 'sql';
}

// ── Express 앱 ────────────────────────────────────────────────────────────────

const app: Application = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeJobs: Map<string, ChildProcess> = new Map();
const sqlStore: Map<string, SqlStore> = new Map();

// ── 엔드포인트 ────────────────────────────────────────────────────────────────

app.get('/meta', (_req: Request, res: Response) => {
  res.json({ updatedAt: tableUpdatedAt });
});

app.get('/meta/table-info', (_req: Request, res: Response) => {
  res.json({ content: loadTableIndex() });
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
  const { requestId, sql: sqlStr, limit = 20 } = req.body;
  if (!sqlStr?.trim()) return res.status(400).json({ error: 'sql 필드가 필요합니다.' });

  try {
    const { body, effectiveSql, table } = await executeSqlInternal(sqlStr, limit);
    if (requestId) sqlStore.set(requestId, { sql: effectiveSql, table });
    sqlStore.set('__latest__', { sql: effectiveSql, table });
    return res.json(body);
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(`${ts()} [타임아웃] ${DB_TIMEOUT_MSG}`);
      return res.status(504).json({ error: DB_TIMEOUT_MSG });
    }
    const msg: string = (err as Error).message;
    console.error(`[DB 오류] ${msg}`);
    return res.status(msg.includes('허용') ? 400 : 500).json({ error: msg });
  }
});

app.post('/db-export', async (req: Request<object, object, DbExportBody>, res: Response) => {
  const { requestId } = req.body;
  const stored: SqlStore | undefined = sqlStore.get(requestId) ?? sqlStore.get('__latest__');
  if (!stored) return res.status(404).json({ error: '조회 파라미터를 찾을 수 없습니다. 먼저 검색을 실행해 주세요.' });

  try {
    const [rows] = await pool.query<RowDataPacket[]>({ sql: stored.sql, timeout: DB_TIMEOUT_MS });
    const data: Record<string, unknown>[] = rows.map((row: RowDataPacket) => {
      const r: Record<string, unknown> = { ...row };
      for (const col of SENSITIVE_COLUMNS) delete r[col];
      return r;
    });
    console.log(`${ts()} [엑셀 내보내기] ${stored.table} ${data.length}건`);
    return res.json({ count: data.length, data, collection: stored.table });
  } catch (err) {
    if (isTimeoutError(err)) return res.status(504).json({ error: DB_TIMEOUT_MSG });
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

app.post('/chat', (req: Request<object, object, ChatBody>, res: Response) => {
  const { message, requestId, limit = 20 } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: '메시지를 입력해 주세요.' });

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
  // shell: false — Windows .cmd shim 우회 (resolveAgyBin 이 .exe 절대경로를 반환)
  const child: ChildProcess = spawn(
    resolveAgyBin(),
    [
      '-p', buildGeminiPrompt(message.trim(), limit),
      '--output-format', 'stream-json',
      '--model', GEMINI_MODEL,
      '--sandbox',
      '--print-timeout', GEMINI_PRINT_TIMEOUT,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: AGY_CHILD_ENV, shell: false }
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

    const parsed = extractJsonFromText(finalResult);
    if (!isLlmSqlPayload(parsed)) {
      console.error(`[오류] agy 출력에서 유효한 kind:"sql" JSON 을 찾지 못함. 원문 앞머리: ${finalResult.slice(0, 200)}`);
      send('error', 'agy 가 쿼리 JSON 을 만들지 못했습니다. 다시 시도해 주세요.');
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`${'─'.repeat(60)}\n`);
      return;
    }
    if (!parsed.sql?.trim()) {
      send('error', 'agy 가 sql 필드를 비워서 반환했습니다. 다시 시도해 주세요.');
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`${'─'.repeat(60)}\n`);
      return;
    }

    send('query', { endpoint: '/db-query', requestBody: parsed as unknown as Record<string, unknown> } satisfies QueryEventPayload);
    send('log', JSON.stringify(parsed));
    send('progress', '조회 시작 — SQL 실행 중...');
    console.log(`${ts()} [조회 시작]  /db-query`);
    console.log(`             ${JSON.stringify(parsed)}`);

    try {
      const { body, effectiveSql, table } = await executeSqlInternal(parsed.sql, parsed.limit ?? limit);
      if (requestId) sqlStore.set(requestId, { sql: effectiveSql, table });
      sqlStore.set('__latest__', { sql: effectiveSql, table });
      send('result-data', body as unknown as ResultDataEventPayload);
      send('progress', `DB 응답 완료 — ${body.count}건 / ${(body.dbTimeMs / 1000).toFixed(2)}초`);
      send('result', '');
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
    send('error', err.code === 'ENOENT' ? 'Antigravity CLI(agy)가 설치되어 있지 않습니다.' : err.message);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ── 서버 시작 ─────────────────────────────────────────────────────────────────

function killPort(port: string): void {
  try {
    const out: string = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    const re: RegExp = new RegExp(`0\\.0\\.0\\.0:${port}\\s.*LISTENING\\s+(\\d+)`, 'i');
    for (const line of out.split('\n')) {
      const m = line.match(re);
      if (!m) continue;
      try {
        execSync(`taskkill /PID ${m[1]} /F`, { stdio: 'ignore' });
        console.log(`포트 ${port} 점유 프로세스(PID ${m[1]}) 종료 완료`);
      } catch { /* 무시 */ }
    }
  } catch { /* 점유 없음 */ }
}

pool.getConnection()
  .then((conn: PoolConnection) => {
    conn.release();
    console.log(`MySQL 연결 완료: ${DB_HOST}:${DB_PORT}/${DB_DATABASE}`);
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
    console.error('MySQL 연결 실패:', err.message);
    process.exit(1);
  });

process.on('SIGINT', async (): Promise<void> => {
  await pool.end();
  console.log('MySQL 커넥션 종료');
  process.exit(0);
});

process.on('SIGTERM', async (): Promise<void> => {
  await pool.end();
  console.log('MySQL 커넥션 종료');
  process.exit(0);
});
