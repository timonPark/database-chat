import Database from 'better-sqlite3';
import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

type DbHandle = InstanceType<typeof Database>;

const SCHEMA_VERSION = 1;
const SIZE_CAP_BYTES = 10 * 1024 * 1024;
const SESSION_META_FILENAME = '_session.json';
const EXPORT_FILE_EXT = '.xlsx';
const MESSAGE_ROLES = ['user', 'assistant'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface SessionRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageInput {
  role: MessageRole;
  text: string;
  generatedQuery?: string | null;
  attachments?: unknown;
}

export interface MessageRow {
  id: string;
  sessionId: string;
  role: MessageRole;
  text: string;
  generatedQuery: string | null;
  attachments: unknown | null;
  createdAt: number;
}

export interface ExportInput {
  sessionId: string;
  messageId: string | null;
  filePath: string;
  fileName: string;
  fileSize: number;
  rowCount: number | null;
  queryText: string | null;
}

export interface ExportRow extends ExportInput {
  id: string;
  createdAt: number;
}

export interface GeneratedExport {
  exportId: string;
  filePath: string;
  fileSize: number;
  rowCount: number;
}

export interface OrphanCleanupResult {
  orphanFiles: number;
  orphanRecords: number;
}

export interface HistoryDb {
  close(): void;

  cleanupOrphans(): OrphanCleanupResult;

  createSession(firstQuery: string): { id: string; title: string };
  listSessions(): SessionRow[];
  renameSession(id: string, title: string): void;
  deleteSession(id: string): void;

  insertMessage(sessionId: string, msg: MessageInput): string;
  listMessages(sessionId: string): MessageRow[];
  getRecentMessages(sessionId: string, limit: number): MessageRow[];

  insertExport(exp: ExportInput): string;
  listExports(sessionId: string): ExportRow[];
  getExport(id: string): ExportRow | null;
  deleteExport(id: string): void;

  generateAndSaveXlsx(
    sessionId: string,
    messageId: string | null,
    rows: Record<string, unknown>[],
    queryText: string | null,
  ): GeneratedExport;

  shouldPromoteToExport(dataByteSize: number): boolean;
}

const MESSAGE_SELECT_COLS = `
  id,
  session_id      AS sessionId,
  role,
  text,
  generated_query AS generatedQuery,
  attachments,
  created_at      AS createdAt
`;

const EXPORT_SELECT_COLS = `
  id,
  session_id AS sessionId,
  message_id AS messageId,
  file_path  AS filePath,
  file_name  AS fileName,
  file_size  AS fileSize,
  row_count  AS rowCount,
  query_text AS queryText,
  created_at AS createdAt
`;

type RawMessageRow = Omit<MessageRow, 'attachments'> & { attachments: string | null };

const mapMessageRow = (r: RawMessageRow): MessageRow => ({
  ...r,
  attachments: r.attachments ? JSON.parse(r.attachments) : null,
});

function assertUuid(id: string, label: string): void {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error(`[history-db] ${label} 는 UUID 형태여야 합니다`);
  }
}

// XLSX / CSV formula injection 방어: 공격자가 심어둔 =, +, -, @ 로 시작하는
// 셀 값이 reviewer 가 엑셀로 열 때 공식으로 실행되는 걸 막는다.
const sanitizeCell = (v: unknown): unknown =>
  typeof v === 'string' && FORMULA_LEAD.test(v) ? `'${v}` : v;

const sanitizeRow = (r: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, sanitizeCell(v)]));

function runMigrations(db: DbHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const row = db
    .prepare('SELECT value FROM schema_meta WHERE key = ?')
    .get('version') as { value: string } | undefined;
  const current = row ? parseInt(row.value, 10) : 0;

  if (current < 1) {
    const roleCheck = MESSAGE_ROLES.map((r) => `'${r}'`).join(',');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK(role IN (${roleCheck})),
        text            TEXT NOT NULL,
        generated_query TEXT,
        attachments     TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS exports (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id  TEXT          REFERENCES messages(id) ON DELETE SET NULL,
        file_path   TEXT NOT NULL,
        file_name   TEXT NOT NULL,
        file_size   INTEGER NOT NULL,
        row_count   INTEGER,
        query_text  TEXT,
        created_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated
        ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_exports_session
        ON exports(session_id, created_at DESC);
    `);
  }

  if (current < SCHEMA_VERSION) {
    db.prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)').run(
      'version',
      String(SCHEMA_VERSION),
    );
  }
}

export function openHistoryDb(projectRoot: string): HistoryDb {
  const dataDir = join(projectRoot, 'data');
  const dbPath = join(dataDir, 'chat-history.db');
  const exportsRoot = join(dataDir, 'exports');
  const resolvedExportsRoot = resolve(exportsRoot);

  mkdirSync(dataDir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  const stmts = {
    insertSession: db.prepare(
      'INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ),
    listSessions: db.prepare(
      `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
       FROM sessions
       ORDER BY updated_at DESC`,
    ),
    updateSessionRename: db.prepare(
      'UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?',
    ),
    getSessionCreatedAt: db.prepare(
      'SELECT created_at FROM sessions WHERE id = ?',
    ),
    bumpSessionUpdatedAt: db.prepare(
      'UPDATE sessions SET updated_at = ? WHERE id = ?',
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),

    insertMessage: db.prepare(
      `INSERT INTO messages
         (id, session_id, role, text, generated_query, attachments, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    listMessages: db.prepare(
      `SELECT ${MESSAGE_SELECT_COLS}
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC`,
    ),
    recentMessages: db.prepare(
      `SELECT ${MESSAGE_SELECT_COLS}
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ),

    insertExport: db.prepare(
      `INSERT INTO exports
         (id, session_id, message_id, file_path, file_name,
          file_size, row_count, query_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listExports: db.prepare(
      `SELECT ${EXPORT_SELECT_COLS}
       FROM exports
       WHERE session_id = ?
       ORDER BY created_at DESC`,
    ),
    getExport: db.prepare(`SELECT ${EXPORT_SELECT_COLS} FROM exports WHERE id = ?`),
    getExportPath: db.prepare('SELECT file_path FROM exports WHERE id = ?'),
    deleteExport: db.prepare('DELETE FROM exports WHERE id = ?'),

    allExportPaths: db.prepare('SELECT file_path FROM exports'),
    deleteExportByPath: db.prepare('DELETE FROM exports WHERE file_path = ?'),
  };

  const insertMessageTx = db.transaction(
    (id: string, sessionId: string, msg: MessageInput, t: number) => {
      const attachmentsJson =
        msg.attachments == null ? null : JSON.stringify(msg.attachments);
      stmts.insertMessage.run(
        id,
        sessionId,
        msg.role,
        msg.text,
        msg.generatedQuery ?? null,
        attachmentsJson,
        t,
      );
      stmts.bumpSessionUpdatedAt.run(t, sessionId);
    },
  );

  const insertExportTx = db.transaction((id: string, exp: ExportInput, t: number) => {
    stmts.insertExport.run(
      id,
      exp.sessionId,
      exp.messageId,
      exp.filePath,
      exp.fileName,
      exp.fileSize,
      exp.rowCount,
      exp.queryText,
      t,
    );
    stmts.bumpSessionUpdatedAt.run(t, exp.sessionId);
  });

  const deleteExportPathsTx = db.transaction((paths: string[]) => {
    for (const p of paths) stmts.deleteExportByPath.run(p);
  });

  // 경로가 data/exports/ 안인지 확인. 이 모듈이 수행하는 모든 FS 쓰기·삭제의 최종 가드.
  const assertInsideExports = (abs: string): void => {
    const r = resolve(abs);
    if (r !== resolvedExportsRoot && !r.startsWith(resolvedExportsRoot + sep)) {
      throw new Error('[history-db] 경로가 data/exports/ 밖입니다');
    }
  };

  // exports.file_path 는 외부 포이즈닝 가능 → insertExport 입구에서 반드시 검증.
  const assertExportRelativePath = (rel: string): void => {
    if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\x00')) {
      throw new Error('[history-db] 잘못된 export 경로');
    }
    assertInsideExports(resolve(projectRoot, rel));
  };

  const sessionFolder = (sessionId: string): string => join(exportsRoot, sessionId);

  const ensureSessionFolder = (sessionId: string): string => {
    assertUuid(sessionId, 'sessionId');
    const dir = sessionFolder(sessionId);
    assertInsideExports(dir);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const writeSessionMeta = (
    sessionId: string,
    title: string,
    createdAt: number,
  ): void => {
    const dir = ensureSessionFolder(sessionId);
    writeFileSync(
      join(dir, SESSION_META_FILENAME),
      JSON.stringify({ title, createdAt }, null, 2) + '\n',
      'utf8',
    );
  };

  const toRelativePath = (abs: string): string =>
    relative(projectRoot, abs).split(sep).join('/');

  const fmtTimestamp = (d: Date): string => {
    const pad = (n: number): string => n.toString().padStart(2, '0');
    return (
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
  };

  const titleFromQuery = (q: string): string => {
    const trimmed = q.trim().replace(/\s+/g, ' ');
    if (!trimmed) return '새 Session';
    return trimmed.length <= 30 ? trimmed : trimmed.slice(0, 30);
  };

  const nowMs = (): number => Date.now();

  const api: HistoryDb = {
    close() {
      db.close();
    },

    cleanupOrphans() {
      mkdirSync(exportsRoot, { recursive: true });

      const records = stmts.allExportPaths.all() as { file_path: string }[];
      const knownPaths = new Set(records.map((r) => r.file_path));

      let orphanFiles = 0;
      for (const sd of readdirSync(exportsRoot, { withFileTypes: true })) {
        if (!sd.isDirectory()) continue;
        const sdPath = join(exportsRoot, sd.name);
        for (const file of readdirSync(sdPath)) {
          if (file === SESSION_META_FILENAME) continue;
          if (!file.endsWith(EXPORT_FILE_EXT)) continue;
          const abs = join(sdPath, file);
          assertInsideExports(abs);
          const rel = toRelativePath(abs);
          if (!knownPaths.has(rel)) {
            rmSync(abs, { force: true });
            orphanFiles += 1;
          }
        }
      }

      const orphanRecordPaths: string[] = [];
      for (const r of records) {
        try {
          statSync(join(projectRoot, r.file_path));
        } catch {
          orphanRecordPaths.push(r.file_path);
        }
      }
      if (orphanRecordPaths.length > 0) deleteExportPathsTx(orphanRecordPaths);

      return { orphanFiles, orphanRecords: orphanRecordPaths.length };
    },

    createSession(firstQuery) {
      const id = randomUUID();
      const title = titleFromQuery(firstQuery);
      const t = nowMs();
      stmts.insertSession.run(id, title, t, t);
      writeSessionMeta(id, title, t);
      return { id, title };
    },

    listSessions() {
      return stmts.listSessions.all() as SessionRow[];
    },

    renameSession(id, title) {
      assertUuid(id, 'sessionId');
      const t = nowMs();
      const info = stmts.updateSessionRename.run(title, t, id);
      if (info.changes === 0) return;
      const row = stmts.getSessionCreatedAt.get(id) as
        | { created_at: number }
        | undefined;
      if (row) writeSessionMeta(id, title, row.created_at);
    },

    deleteSession(id) {
      assertUuid(id, 'sessionId');
      stmts.deleteSession.run(id);
      const dir = sessionFolder(id);
      assertInsideExports(dir);
      rmSync(dir, { recursive: true, force: true });
    },

    insertMessage(sessionId, msg) {
      assertUuid(sessionId, 'sessionId');
      const id = randomUUID();
      insertMessageTx(id, sessionId, msg, nowMs());
      return id;
    },

    listMessages(sessionId) {
      assertUuid(sessionId, 'sessionId');
      return (stmts.listMessages.all(sessionId) as RawMessageRow[]).map(mapMessageRow);
    },

    getRecentMessages(sessionId, limit) {
      assertUuid(sessionId, 'sessionId');
      return (stmts.recentMessages.all(sessionId, limit) as RawMessageRow[])
        .reverse()
        .map(mapMessageRow);
    },

    insertExport(exp) {
      assertUuid(exp.sessionId, 'sessionId');
      if (exp.messageId !== null) assertUuid(exp.messageId, 'messageId');
      assertExportRelativePath(exp.filePath);
      const id = randomUUID();
      insertExportTx(id, exp, nowMs());
      return id;
    },

    listExports(sessionId) {
      assertUuid(sessionId, 'sessionId');
      return stmts.listExports.all(sessionId) as ExportRow[];
    },

    getExport(id) {
      assertUuid(id, 'exportId');
      const row = stmts.getExport.get(id) as ExportRow | undefined;
      return row ?? null;
    },

    deleteExport(id) {
      assertUuid(id, 'exportId');
      const row = stmts.getExportPath.get(id) as
        | { file_path: string }
        | undefined;
      stmts.deleteExport.run(id);
      if (row) {
        const abs = resolve(projectRoot, row.file_path);
        assertInsideExports(abs);
        rmSync(abs, { force: true });
      }
    },

    generateAndSaveXlsx(sessionId, messageId, rows, queryText) {
      assertUuid(sessionId, 'sessionId');
      if (messageId !== null) assertUuid(messageId, 'messageId');

      const sessionDir = ensureSessionFolder(sessionId);
      const prefix = messageId ?? randomUUID();
      const fileName = `${prefix}-${fmtTimestamp(new Date())}${EXPORT_FILE_EXT}`;
      const abs = join(sessionDir, fileName);
      assertInsideExports(abs);
      const rel = toRelativePath(abs);

      const safeRows = rows.map(sanitizeRow);
      const ws = XLSX.utils.json_to_sheet(safeRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '조회결과');
      XLSX.writeFile(wb, abs);

      const fileSize = statSync(abs).size;
      const exportId = api.insertExport({
        sessionId,
        messageId,
        filePath: rel,
        fileName,
        fileSize,
        rowCount: rows.length,
        queryText,
      });

      return { exportId, filePath: rel, fileSize, rowCount: rows.length };
    },

    shouldPromoteToExport(dataByteSize) {
      return dataByteSize > SIZE_CAP_BYTES;
    },
  };

  return api;
}
