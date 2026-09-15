import 'dotenv/config';
import express, { Request, Response, Application } from 'express';
import { spawn, execSync, ChildProcess } from 'child_process';
import oracledb from 'oracledb';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';

// ── 환경 변수 ──────────────────────────────────────────────────────────────────

const PORT: string = process.env.PORT ?? '3111';
const DB_HOST: string | undefined = process.env.DB_HOST;
const DB_PORT: string = process.env.DB_PORT ?? '1521';
const DB_SERVICE_NAME: string | undefined = process.env.DB_SERVICE_NAME;
const DB_USER_NAME: string | undefined = process.env.DB_USER_NAME;
const DB_USER_PASSWORD: string | undefined = process.env.DB_USER_PASSWORD;
const TABLE_MAPPING_FILE: string = process.env.TABLE_MAPPING_FILE ?? './table-mapping.md';
const CLAUDE_MODEL: string = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
const CLAUDE_MAX_TURNS: string = process.env.CLAUDE_MAX_TURNS ?? '10';
const TABLE_INDEX_FILE: string = './index.md';
const TABLES_DIR: string = path.resolve(import.meta.dirname, 'tables');

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

function buildSystemPrompt(requestId: string, limit: number = 20): string {
  return `Oracle 조회 어시스턴트. 설명 없이 즉시 curl로 쿼리 실행 후 결과를 한국어로 답한다.

[테이블]
${buildTableSummary()}

[테이블 선택 가이드: 테이블명 | 자연어 키워드 | 주요 컬럼 | 설명]
${buildTableGuide()}

[컬럼 확인] 컬럼명 불확실 시: cat "${TABLES_DIR}/<테이블명>.md"

[SQL 조회] curl -sX POST http://localhost:${PORT}/db-query -H 'Content-Type: application/json' -d '{"requestId":"${requestId}","sql":"SELECT ... FROM ... WHERE ... FETCH FIRST ${limit} ROWS ONLY","limit":${limit}}'

규칙:
- password·pass_hash·passwd·pwd·secret 컬럼은 반드시 제외
- LIMIT 대신 반드시 FETCH FIRST ${limit} ROWS ONLY 사용 (Oracle 문법)
- 더 오래된 문법이 필요한 경우 ROWNUM <= ${limit} 사용 가능
- SELECT, EXPLAIN PLAN FOR, SHOW, DESCRIBE, DESC 만 허용 (DML/DDL 불가)
- 기본 조회 건수는 반드시 ${limit}건. 엑셀 내보내기는 동일 쿼리를 그대로 실행함
- 결과 없으면 즉시 "조회된 데이터가 없습니다"
- 오류 시 원인 설명`;
}

// ── Oracle 풀 ─────────────────────────────────────────────────────────────────

let pool: oracledb.Pool;

// ── 유틸 ──────────────────────────────────────────────────────────────────────

const ts: () => string = () => new Date().toTimeString().slice(0, 8);

const DB_TIMEOUT_MS: number = 30_000;
const DB_TIMEOUT_MSG: string = 'DB 응답시간 초과 Max 30초';

function isTimeoutError(err: unknown): boolean {
  return (err as { errorNum?: number }).errorNum === 1013; // ORA-01013: user requested cancel of current operation
}

const SENSITIVE_COLUMNS: string[] = ['password', 'pass_hash', 'passwd', 'pwd', 'secret'];
const ALLOWED_SQL_PREFIXES: string[] = ['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC'];

function removeSensitiveColumns(data: Record<string, unknown>[]): Record<string, unknown>[] {
  return data.map(row => {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!SENSITIVE_COLUMNS.includes(key.toLowerCase())) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  });
}

function removeLimitFromSql(sql: string): string {
  // Oracle: remove FETCH FIRST n ROWS ONLY
  let result = sql.replace(/\bFETCH\s+FIRST\s+\d+\s+ROWS\s+ONLY\b/gi, '');
  // Oracle: remove ROWNUM condition (WHERE ROWNUM <= n or AND ROWNUM <= n)
  result = result.replace(/\bAND\s+ROWNUM\s*<=?\s*\d+\b/gi, '');
  result = result.replace(/\bWHERE\s+ROWNUM\s*<=?\s*\d+\b/gi, '');
  return result.trim();
}

// ── 쿼리 파라미터 저장소 (엑셀 내보내기용) ────────────────────────────────────

interface QueryRecord {
  sql: string;
}

const queryParamsStore: Map<string, QueryRecord> = new Map();

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
            if (cmd.includes('/db-query')) {
              console.log(`${ts()} [조회 시작]  DB 쿼리 실행 중...`);
              console.log(`             $ ${cmd}`);
              send('progress', '조회 시작 — DB 쿼리 실행 중...');
              const singleMatch: RegExpMatchArray | null = cmd.match(/-d\s+'([^']+)'/);
              const doubleMatch: RegExpMatchArray | null = cmd.match(/-d\s+"((?:[^"\\]|\\.)*)"/);
              const rawData: string | undefined = singleMatch?.[1] ?? doubleMatch?.[1]?.replace(/\\"/g, '"');
              if (rawData) {
                try {
                  const parsed: unknown = JSON.parse(rawData);
                  const display: string = JSON.stringify(parsed, null, 2);
                  send('log', display.length > 600 ? display.slice(0, 600) + '\n...(생략)' : display);
                } catch {
                  const sqlMatch: RegExpMatchArray | null = rawData.match(/["']sql["']\s*:\s*["']([^"']+)["']/);
                  send('log', sqlMatch ? `sql: ${sqlMatch[1]}` : rawData.slice(0, 200));
                }
              }
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
        } else if (hasText && lastEventType === 'user') {
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

// ── 엔드포인트 ────────────────────────────────────────────────────────────────

app.get('/meta', (_req: Request, res: Response) => {
  res.json({ updatedAt: tableUpdatedAt });
});

app.get('/meta/table-info', (_req: Request, res: Response) => {
  res.json({ content: loadTableIndex() });
});

app.post('/db-query', async (req: Request<object, object, DbQueryBody>, res: Response) => {
  const { requestId, sql, limit = 20 } = req.body;

  if (!sql?.trim()) {
    return res.status(400).json({ error: 'sql 필드가 필요합니다.' });
  }

  const sqlUpper: string = sql.trim().toUpperCase();
  const isAllowed: boolean = ALLOWED_SQL_PREFIXES.some(prefix => sqlUpper.startsWith(prefix));
  if (!isAllowed) {
    return res.status(400).json({ error: `허용되지 않는 SQL 입니다. ${ALLOWED_SQL_PREFIXES.join(', ')} 만 허용됩니다.` });
  }

  if (requestId) queryParamsStore.set(requestId, { sql: sql.trim() });
  queryParamsStore.set('__latest__', { sql: sql.trim() });

  let conn: oracledb.Connection | null = null;
  try {
    const dbStart: number = Date.now();
    conn = await pool.getConnection();

    const result = await conn.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      maxRows: limit ?? 20,
      fetchArraySize: 100,
    });

    const data = (result.rows ?? []) as Record<string, unknown>[];
    const cleanData = removeSensitiveColumns(data);
    const dbTimeMs: number = Date.now() - dbStart;

    if (cleanData.length === 0) {
      return res.json({ count: 0, data: [], dbTimeMs, message: '조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라.' });
    }

    return res.json({ count: cleanData.length, data: cleanData, dbTimeMs });
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(`${ts()} [타임아웃] ${DB_TIMEOUT_MSG}`);
      return res.status(504).json({ error: DB_TIMEOUT_MSG });
    }
    console.error(`[DB 오류] ${(err as Error).message}`);
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    if (conn) {
      try { await conn.close(); } catch { /* 무시 */ }
    }
  }
});

app.post('/db-export', async (req: Request<object, object, DbExportBody>, res: Response) => {
  const { requestId } = req.body;
  const params: QueryRecord | undefined = queryParamsStore.get(requestId) ?? queryParamsStore.get('__latest__');
  if (!params) {
    return res.status(404).json({ error: '조회 파라미터를 찾을 수 없습니다. 먼저 검색을 실행해 주세요.' });
  }

  let conn: oracledb.Connection | null = null;
  try {
    conn = await pool.getConnection();
    const result = await conn.execute(params.sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchArraySize: 100,
    });
    const data = (result.rows ?? []) as Record<string, unknown>[];
    const cleanData = removeSensitiveColumns(data);

    console.log(`${ts()} [엑셀 내보내기] ${cleanData.length}건`);
    return res.json({ count: cleanData.length, data: cleanData });
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(`${ts()} [타임아웃] ${DB_TIMEOUT_MSG}`);
      return res.status(504).json({ error: DB_TIMEOUT_MSG });
    }
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
