import 'dotenv/config';
import express, { Request, Response, Application } from 'express';
import { spawn, execSync, ChildProcess } from 'child_process';
import oracledb from 'oracledb';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { loadAllSchemas } from './scripts/load-schema-index.js';
import { analyzeSql } from './scripts/sql-analyze.js';
import { buildColumnsFromSql } from './scripts/build-columns.js';

// ── 환경 변수 ──────────────────────────────────────────────────────────────────

const PORT: string = process.env.PORT ?? '3111';
const DB_HOST: string | undefined = process.env.DB_HOST;
const DB_PORT: string = process.env.DB_PORT ?? '1521';
const DB_SERVICE_NAME: string | undefined = process.env.DB_SERVICE_NAME;
const DB_USER_NAME: string | undefined = process.env.DB_USER_NAME;
const DB_USER_PASSWORD: string | undefined = process.env.DB_USER_PASSWORD;
const TABLE_MAPPING_FILE: string = process.env.TABLE_MAPPING_FILE ?? './table-mapping.md';
const CLAUDE_MODEL: string = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
const TABLE_INDEX_FILE: string = './index.md';
const TABLES_DIR: string = path.resolve(import.meta.dirname, 'tables');

// Claude 자식 프로세스에 상속시키지 않을 민감 키
const CLAUDE_CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const SENSITIVE_KEYS: readonly string[] = [
    'DB_HOST', 'DB_PORT', 'DB_SERVICE_NAME',
    'DB_USER_NAME', 'DB_USER_PASSWORD',
  ];
  for (const key of SENSITIVE_KEYS) delete env[key];
  return env;
})();

if (!DB_HOST || !DB_SERVICE_NAME || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경 변수가 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

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

interface ClaudeTextBlock { type: 'text'; text?: string; }
interface ClaudeToolUseBlock { type: 'tool_use'; name: string; input?: { command?: string }; }
type ClaudeContentBlock = ClaudeToolUseBlock | ClaudeTextBlock;
interface ClaudeSystemEvent { type: 'system'; }
interface ClaudeAssistantEvent { type: 'assistant'; message?: { content?: ClaudeContentBlock[] }; }
interface ClaudeResultEvent { type: 'result'; subtype: string; result?: string; cost_usd?: number; }
type ClaudeEvent = ClaudeSystemEvent | ClaudeAssistantEvent | ClaudeResultEvent;

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
  return `Oracle 조회 쿼리 생성기. 사용자 자연어 요청 → **정확히 하나의 JSON 객체** 만 출력하고 종료.

**절대 규칙**:
- 응답은 오직 하나의 JSON 객체. 앞뒤에 설명·인사·마크다운 코드펜스·요약 어떤 것도 붙이지 마라
- 도구 · 명령 실행 없음. curl · bash · cat 등 사용 금지 (도구가 제공되지 않음)
- 서버가 이 JSON 을 파싱해 DB 를 조회하고 결과를 UI 에 직접 그린다. 너는 결과를 볼 수 없고, 결과를 안내할 필요도 없다

**출력 형식** (하나만):

{"kind":"sql","sql":"SELECT col1, col2 FROM SCHEMA.TABLE WHERE ... ORDER BY ... FETCH FIRST ${limit} ROWS ONLY"}

[테이블]
${buildTableSummary()}

[테이블 선택 가이드: 테이블명 | 자연어 키워드 | 주요 컬럼 | 설명]
${buildTableGuide()}

규칙:
- password · pass_hash · passwd · pwd · secret 컬럼은 반드시 제외
- SELECT · WITH · EXPLAIN PLAN FOR · SHOW · DESCRIBE · DESC 만 허용 (DML/DDL 절대 금지)
- **LIMIT 문법 없음** — 반드시 \`FETCH FIRST ${limit} ROWS ONLY\` (12c+) 또는 \`WHERE ROWNUM <= ${limit}\` (레거시) 사용
- ORDER BY 와 FETCH FIRST 는 함께 (ORDER BY 없이 FETCH 는 결과 순서 비결정)
- 대문자 오브젝트가 기본. 소문자 · 특수문자 이름은 \`"\` 로 감쌈
- JOIN 시 alias 는 짧게 (t1, t2 등). SELECT 컬럼 라벨링은 서버가 처리
- 단순 WHERE · ORDER BY 든 JOIN · GROUP BY · 서브쿼리 · HAVING 이든 동일하게 kind:"sql" 하나로 처리`;
}

// ── SQL 보안 검증 ─────────────────────────────────────────────────────────────

const ALLOWED_SQL_PREFIXES: string[] = ['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC'];
const BLOCKED_SQL_KEYWORDS: RegExp = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|EXEC|EXECUTE|CALL|GRANT|REVOKE|BEGIN|DECLARE)\b/i;
const SENSITIVE_COLUMNS: string[] = ['password', 'pass_hash', 'passwd', 'pwd', 'secret'];

function validateSql(sqlStr: string): void {
  const trimmed: string = sqlStr.trim().toUpperCase();
  const isAllowed: boolean = ALLOWED_SQL_PREFIXES.some(prefix => trimmed.startsWith(prefix));
  if (!isAllowed) throw new Error('SELECT · WITH · EXPLAIN PLAN FOR · SHOW · DESCRIBE · DESC 쿼리만 허용됩니다.');
  if (BLOCKED_SQL_KEYWORDS.test(sqlStr)) throw new Error('허용되지 않는 SQL 키워드가 포함되어 있습니다.');
}

// ── 유틸 ──────────────────────────────────────────────────────────────────────

const ts: () => string = () => new Date().toTimeString().slice(0, 8);
const DB_TIMEOUT_MS: number = 30_000;
const DB_TIMEOUT_MSG: string = 'DB 응답시간 초과 Max 30초';

function isTimeoutError(err: unknown): boolean {
  return (err as { errorNum?: number }).errorNum === 1013; // ORA-01013
}

function removeSensitiveColumns(data: Record<string, unknown>[]): Record<string, unknown>[] {
  return data.map((row) => {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!SENSITIVE_COLUMNS.includes(key.toLowerCase())) cleaned[key] = value;
    }
    return cleaned;
  });
}

// ── Oracle 풀 ─────────────────────────────────────────────────────────────────

let pool: oracledb.Pool;

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

async function executeSqlInternal(rawSql: string): Promise<{ body: SqlResultBody; effectiveSql: string; table: string }> {
  validateSql(rawSql);
  const effectiveSql: string = rawSql.trim();
  const analysis = analyzeSql(effectiveSql);
  const table: string = analysis.baseTable ?? 'result';

  let conn: oracledb.Connection | null = null;
  const dbStart: number = Date.now();
  try {
    conn = await pool.getConnection();
    conn.callTimeout = DB_TIMEOUT_MS;
    const result = await conn.execute<Record<string, unknown>>(effectiveSql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const dbTimeMs: number = Date.now() - dbStart;

    const rawData: Record<string, unknown>[] = (result.rows ?? []) as Record<string, unknown>[];
    const data: Record<string, unknown>[] = removeSensitiveColumns(rawData);
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
  } finally {
    if (conn) {
      try { await conn.close(); } catch { /* 무시 */ }
    }
  }
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

// ── Claude 이벤트 핸들러 ──────────────────────────────────────────────────────

function createClaudeEventHandler(send: SendFn): (event: ClaudeEvent) => void {
  let systemSeen: boolean = false;

  return function handleClaudeEvent(event: ClaudeEvent): void {
    switch (event.type) {
      case 'system':
        if (!systemSeen) {
          systemSeen = true;
          console.log(`${ts()} [준비]      Claude 세션 시작`);
          send('progress', '쿼리 생성 준비 중...');
        }
        break;

      case 'assistant': {
        const contents: ClaudeContentBlock[] = event.message?.content ?? [];
        const hasText: boolean = contents.some(b => b.type === 'text');
        if (hasText) send('progress', '쿼리 생성 중...');
        break;
      }

      case 'result':
        if (event.subtype === 'success') {
          console.log(`${ts()} [LLM 응답 완료] cost=$${event.cost_usd?.toFixed(4) ?? '?'}`);
        } else {
          console.log(`${ts()} [LLM 실패]  subtype=${event.subtype}`);
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
  const { requestId, sql: sqlStr } = req.body;
  if (!sqlStr?.trim()) return res.status(400).json({ error: 'sql 필드가 필요합니다.' });

  try {
    const { body, effectiveSql, table } = await executeSqlInternal(sqlStr);
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

  let conn: oracledb.Connection | null = null;
  try {
    conn = await pool.getConnection();
    conn.callTimeout = DB_TIMEOUT_MS;
    const result = await conn.execute<Record<string, unknown>>(stored.sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const rawData: Record<string, unknown>[] = (result.rows ?? []) as Record<string, unknown>[];
    const data: Record<string, unknown>[] = removeSensitiveColumns(rawData);
    console.log(`${ts()} [엑셀 내보내기] ${stored.table} ${data.length}건`);
    return res.json({ count: data.length, data, collection: stored.table });
  } catch (err) {
    if (isTimeoutError(err)) return res.status(504).json({ error: DB_TIMEOUT_MSG });
    console.error(`[DB 내보내기 오류] ${(err as Error).message}`);
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    if (conn) {
      try { await conn.close(); } catch { /* 무시 */ }
    }
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

  const child: ChildProcess = spawn(
    'claude',
    [
      '-p', message.trim(),
      '--allowedTools', '__none__',
      '--system-prompt', buildSystemPrompt(limit),
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', '1',
      '--model', CLAUDE_MODEL,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: CLAUDE_CHILD_ENV },
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
        if (event.type === 'result' && event.subtype === 'success') finalResult = event.result ?? '';
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
      console.error('[오류] Claude 프로세스 실패 (exit code:', code, ')');
      console.error(stderr);
      send('error', 'Claude 프로세스 실행 실패: ' + stderr.slice(0, 200));
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`${'─'.repeat(60)}\n`);
      return;
    }

    const parsed = extractJsonFromText(finalResult);
    if (!isLlmSqlPayload(parsed)) {
      console.error(`[오류] LLM 출력에서 유효한 kind:"sql" JSON 을 찾지 못함. 원문 앞머리: ${finalResult.slice(0, 200)}`);
      send('error', 'LLM 이 쿼리 JSON 을 만들지 못했습니다. 다시 시도해 주세요.');
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`${'─'.repeat(60)}\n`);
      return;
    }
    if (!parsed.sql?.trim()) {
      send('error', 'LLM 이 sql 필드를 비워서 반환했습니다. 다시 시도해 주세요.');
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
      const { body, effectiveSql, table } = await executeSqlInternal(parsed.sql);
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
  } catch { /* 점유 없음 */ }
}

oracledb
  .createPool({
    user: DB_USER_NAME,
    password: DB_USER_PASSWORD,
    connectString: `${DB_HOST}:${DB_PORT}/${DB_SERVICE_NAME}`,
    poolMax: 5,
    poolMin: 1,
  })
  .then((createdPool: oracledb.Pool): void => {
    pool = createdPool;
    console.log(`Oracle 연결 완료: ${DB_HOST}:${DB_PORT}/${DB_SERVICE_NAME}`);
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
    console.error('Oracle 연결 실패:', err.message);
    process.exit(1);
  });

process.on('SIGINT', async (): Promise<void> => {
  await pool.close();
  console.log('Oracle 풀 종료');
  process.exit(0);
});

process.on('SIGTERM', async (): Promise<void> => {
  await pool.close();
  console.log('Oracle 풀 종료');
  process.exit(0);
});
