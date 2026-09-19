import 'dotenv/config';
import express, { Request, Response, Application } from 'express';
import { spawn, execSync, ChildProcess } from 'child_process';
import sql from 'mssql';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';

// ── 환경 변수 ──────────────────────────────────────────────────────────────────

const PORT: string = process.env.PORT ?? '3111';
const DB_HOST: string | undefined = process.env.DB_HOST;
const DB_PORT: string = process.env.DB_PORT ?? '1433';
const DB_DATABASE: string | undefined = process.env.DB_DATABASE;
const DB_USER_NAME: string | undefined = process.env.DB_USER_NAME;
const DB_USER_PASSWORD: string | undefined = process.env.DB_USER_PASSWORD;
const TABLE_MAPPING_FILE: string = process.env.TABLE_MAPPING_FILE ?? './table-mapping.md';
const GEMINI_MODEL: string = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash-medium';
const GEMINI_PRINT_TIMEOUT: string = process.env.GEMINI_PRINT_TIMEOUT?.trim() || '5m';
const TABLE_INDEX_FILE: string = './index.md';
const TABLES_DIR: string = path.resolve(import.meta.dirname, 'tables');

if (!DB_HOST || !DB_DATABASE || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경 변수가 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

// ── MSSQL 연결 풀 ─────────────────────────────────────────────────────────────

let pool: sql.ConnectionPool;

// ── 타입 정의 ──────────────────────────────────────────────────────────────────

interface DbQueryBody {
  requestId?: string;
  sql?: string;
  limit?: number;
}

interface DbAggregateBody {
  requestId?: string;
  sql?: string;
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

// ── 테이블 인덱스 로드 ─────────────────────────────────────────────────────────

let tableIndex: string = '';
let tableUpdatedAt: string = '';

try {
  tableIndex = fs.readFileSync(path.resolve(TABLE_INDEX_FILE), 'utf-8');
  const match: RegExpMatchArray | null = tableIndex.match(/최종 업데이트[:：]\s*(.+)/);
  if (match) tableUpdatedAt = match[1].trim();
} catch {
  console.warn(`테이블 인덱스 파일을 읽을 수 없습니다: ${TABLE_INDEX_FILE}`);
  try {
    tableIndex = fs.readFileSync(path.resolve(TABLE_MAPPING_FILE), 'utf-8');
  } catch {
    console.warn(`테이블 매핑 파일도 읽을 수 없습니다: ${TABLE_MAPPING_FILE}`);
  }
}

function loadTableIndex(): string {
  try {
    const content: string = fs.readFileSync(path.resolve(TABLE_INDEX_FILE), 'utf-8');
    const match: RegExpMatchArray | null = content.match(/최종 업데이트[:：]\s*(.+)/);
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

function buildSystemPrompt(requestId: string, limit: number = 20): string {
  return `MSSQL 조회 어시스턴트. 설명 없이 즉시 curl로 쿼리 실행 후 결과를 한국어로 답한다.

[테이블]
${buildTableSummary()}

[테이블 선택 가이드: 테이블명 | 자연어 키워드 | 주요 컬럼 | 설명]
${buildTableGuide()}

[스키마 확인] 컬럼명 불확실 시: cat "${TABLES_DIR}/<테이블명>.md"

[단순 조회] curl -sX POST http://localhost:${PORT}/db-query -H 'Content-Type: application/json' -d '{"requestId":"${requestId}","sql":"SELECT TOP ${limit} col1, col2 FROM schema.table WHERE ... ORDER BY ..."}'

[집계/조인] curl -sX POST http://localhost:${PORT}/db-aggregate -H 'Content-Type: application/json' -d '{"requestId":"${requestId}","sql":"SELECT TOP ${limit} t1.col, COUNT(*) FROM schema.t1 JOIN schema.t2 ON t1.id = t2.t1_id WHERE ... GROUP BY ... HAVING ... ORDER BY ..."}'

규칙:
- password·pass_hash·passwd·pwd·secret 컬럼은 반드시 SELECT에서 제외
- SELECT / WITH / EXPLAIN / SHOW / DESCRIBE / DESC 로 시작하는 읽기 전용 쿼리만 허용 (INSERT·UPDATE·DELETE·DROP·ALTER·CREATE·TRUNCATE·MERGE·EXEC·EXECUTE·BULK INSERT 금지)
- 단순 WHERE·ORDER BY는 /db-query, JOIN·GROUP BY·서브쿼리·HAVING·CTE는 /db-aggregate
- **반드시 스키마 포함 테이블명 사용 (예: SalesLT.Product, dbo.ErrorLog) — 스키마 없이 쓰면 오류 발생**
- LIMIT 대신 반드시 SELECT TOP ${limit} ... 또는 ... OFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY 사용 (T-SQL 문법)
- 기본 조회 건수는 반드시 ${limit}건. 엑셀 내보내기는 동일 쿼리를 그대로 실행함
- 날짜 조건은 ISO 8601 형식을 사용한다: '2020-01-01'
- 응답 JSON에 truncatedTo 필드가 있으면 LLM tool 출력 한도로 서버가 상위 truncatedTo건만 전송한 상태다. 재쿼리·python/wc 우회·재시도 모두 금지, 반환된 data 배열 그대로 사용자에게 응답한다. 더 많은 필드/건수가 필요하면 다음 요청에서 SELECT 컬럼을 줄이거나 LIMIT을 낮춰 재요청한다
- 스키마 확인은 반드시 cat "${TABLES_DIR}/<테이블명>.md" 로만 한다. 실 DB 쿼리로 정찰하지 말 것
- 첫 쿼리가 성공했으면 결과를 그대로 사용해 응답한다. 검증·refinement 목적의 재호출 금지
- 숫자로도 문자열로도 저장 가능한 값(전화번호·사번·주민등록번호 등)은 우선 값 그대로 조회한 뒤 결과가 0건이면 타입을 반대로 바꿔 한 번 더 재시도한다. 예) WHERE phone = '01012345678' 로 0건이면 WHERE TRY_CAST(phone AS INT) = 01012345678 또는 WHERE phone = CONVERT(NVARCHAR, 01012345678) 로 재조회. 재조회에서도 0건이면 "조회된 데이터가 없습니다"
- 결과 없으면 즉시 "조회된 데이터가 없습니다"
- 오류 시 원인 설명 후 쿼리 수정하여 재시도`;
}

function buildGeminiPrompt(message: string, requestId: string, limit: number = 20): string {
  return `${buildSystemPrompt(requestId, limit)}

[사용자 질문]
${message}`;
}

// ── SQL 보안 검증 ─────────────────────────────────────────────────────────────

const ALLOWED_SQL_PREFIXES: string[] = ['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC'];
const BLOCKED_SQL_KEYWORDS: RegExp = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE|MERGE|EXEC|EXECUTE|GRANT|REVOKE|BULK\s+INSERT)\b/i;
const SENSITIVE_COLUMNS: string[] = ['password', 'pass_hash', 'passwd', 'pwd', 'secret'];

function validateSql(sqlStr: string): void {
  const trimmed: string = sqlStr.trim().toUpperCase();
  const isAllowed: boolean = ALLOWED_SQL_PREFIXES.some(prefix => trimmed.startsWith(prefix));
  if (!isAllowed) throw new Error(`허용되지 않는 SQL 입니다. ${ALLOWED_SQL_PREFIXES.join(', ')} 만 허용됩니다.`);
  if (BLOCKED_SQL_KEYWORDS.test(sqlStr)) throw new Error('허용되지 않는 SQL 키워드가 포함되어 있습니다.');
}

function extractTableName(sqlStr: string): string {
  const cleaned: string = sqlStr.replace(/[[\]"`]/g, '');
  const match: RegExpMatchArray | null = cleaned.match(/FROM\s+([\w.]+)/i);
  return match?.[1] ?? 'result';
}

function removeSensitiveColumns(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(row => {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!SENSITIVE_COLUMNS.includes(key.toLowerCase())) cleaned[key] = value;
    }
    return cleaned;
  });
}

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
  const msg = (err as Error).message ?? '';
  return msg.toLowerCase().includes('timeout');
}

async function runReadOnlyQuery(sqlStr: string): Promise<Record<string, unknown>[]> {
  // 요청 타임아웃은 풀 설정의 requestTimeout(DB_TIMEOUT_MS)을 그대로 사용한다.
  const result = await pool.request().query(sqlStr);
  return removeSensitiveColumns(result.recordset as Record<string, unknown>[]);
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
    hint: `LLM tool 출력 한도(약 8KB) 대응: 요청한 ${originalCount}건 중 상위 ${kept}건만 전송. 재쿼리·재실행 금지. 이 결과 그대로 사용자에게 응답하세요. 더 많은 필드가 필요하면 다음 시도에서 SELECT 컬럼을 줄이거나 LIMIT을 낮추세요.`,
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
    console.log(`${ts()} [스키마 확인]  ${file} 읽는 중...`);
    send('progress', `스키마 확인 — ${file} 읽는 중...`);
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
const activeSends: Map<string, SendFn> = new Map();
const sqlStore: Map<string, SqlStore> = new Map();

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
    validateSql(sqlStr);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }

  void limit; // T-SQL에서는 SQL 안에 TOP n / FETCH NEXT n으로 LIMIT을 포함시킴

  const tableName: string = extractTableName(sqlStr);
  if (requestId) sqlStore.set(requestId, { sql: sqlStr, table: tableName });
  sqlStore.set('__latest__', { sql: sqlStr, table: tableName });

  sendDbStart(requestId, '쿼리', { requestId, sql: sqlStr, limit });

  try {
    const dbStart: number = Date.now();
    const data: Record<string, unknown>[] = await runReadOnlyQuery(sqlStr);
    const dbTimeMs: number = Date.now() - dbStart;

    if (data.length === 0) {
      sendDbResult(requestId, 0, dbTimeMs);
      return res.json({ count: 0, data: [], dbTimeMs, message: '조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라.' });
    }
    sendDbResult(requestId, data.length, dbTimeMs);
    return res.json(capForToolOutput({ count: data.length, data, dbTimeMs }));
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(`${ts()} [타임아웃] ${DB_TIMEOUT_MSG}`);
      sendDbError(requestId, DB_TIMEOUT_MSG);
      return res.status(504).json({ error: DB_TIMEOUT_MSG });
    }
    console.error(`[DB 오류] ${(err as Error).message}`);
    sendDbError(requestId, (err as Error).message);
    return res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/db-aggregate', async (req: Request<object, object, DbAggregateBody>, res: Response) => {
  const { requestId, sql: sqlStr } = req.body;

  if (!sqlStr?.trim()) return res.status(400).json({ error: 'sql 필드가 필요합니다.' });

  try {
    validateSql(sqlStr);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }

  const tableName: string = extractTableName(sqlStr);
  if (requestId) sqlStore.set(requestId, { sql: sqlStr, table: tableName });
  sqlStore.set('__latest__', { sql: sqlStr, table: tableName });

  sendDbStart(requestId, '집계', { requestId, sql: sqlStr });

  try {
    const dbStart: number = Date.now();
    const data: Record<string, unknown>[] = await runReadOnlyQuery(sqlStr);
    const dbTimeMs: number = Date.now() - dbStart;

    if (data.length === 0) {
      sendDbResult(requestId, 0, dbTimeMs);
      return res.json({ count: 0, data: [], dbTimeMs, message: '조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라.' });
    }
    sendDbResult(requestId, data.length, dbTimeMs);
    return res.json(capForToolOutput({ count: data.length, data, dbTimeMs }));
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(`${ts()} [타임아웃] ${DB_TIMEOUT_MSG}`);
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
  const stored: SqlStore | undefined = sqlStore.get(requestId) ?? sqlStore.get('__latest__');
  if (!stored) return res.status(404).json({ error: '조회 파라미터를 찾을 수 없습니다. 먼저 검색을 실행해 주세요.' });

  try {
    const data: Record<string, unknown>[] = await runReadOnlyQuery(stored.sql);
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
    activeSends.delete(requestId);
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

async function startServer(): Promise<void> {
  pool = await sql.connect({
    server: DB_HOST!,
    port: Number(DB_PORT),
    database: DB_DATABASE,
    user: DB_USER_NAME,
    password: DB_USER_PASSWORD,
    options: { trustServerCertificate: true, enableArithAbort: true },
    connectionTimeout: 10_000,
    requestTimeout: DB_TIMEOUT_MS,
    pool: { max: 5, min: 1 },
  });
  console.log(`MSSQL 연결 완료: ${DB_HOST}:${DB_PORT}/${DB_DATABASE}`);

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
}

startServer().catch((err: Error): void => {
  console.error('MSSQL 연결 실패:', err.message);
  process.exit(1);
});

process.on('SIGINT', async (): Promise<void> => {
  await pool.close();
  console.log('MSSQL 풀 종료');
  process.exit(0);
});

process.on('SIGTERM', async (): Promise<void> => {
  await pool.close();
  console.log('MSSQL 풀 종료');
  process.exit(0);
});
