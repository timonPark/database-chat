#!/usr/bin/env tsx
import 'dotenv/config';
import mysql from 'mysql2/promise';

const { DB_HOST, DB_PORT, DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD } = process.env;

if (!DB_DATABASE || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const SYSTEM_SCHEMAS = new Set(['mysql', 'sys', 'performance_schema', 'information_schema']);
if (SYSTEM_SCHEMAS.has(DB_DATABASE.toLowerCase())) {
  console.error(`DB_DATABASE(${DB_DATABASE})는 시스템 스키마입니다. 사용자 DB로 다시 지정하세요.`);
  process.exit(1);
}

const conn = await mysql.createConnection({
  host: DB_HOST ?? 'localhost',
  port: Number(DB_PORT ?? 3306),
  database: DB_DATABASE,
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
});

// 뷰는 정의 시점 서브쿼리를 매 조회마다 실행해 매우 느려질 수 있고, 시스템 오브젝트에 대한
// 권한이 없으면 실패하기도 하므로 BASE TABLE 만 대상으로 삼는다.
const [tables] = await conn.query<mysql.RowDataPacket[]>(
  `SELECT TABLE_NAME
   FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
   ORDER BY TABLE_NAME`,
  [DB_DATABASE],
);

console.error(`테이블 ${tables.length}개 발견 (BASE TABLE 만, view/system 제외)`);
const startedAt = Date.now();

type Failed = { __failed: true; reason: string };
async function withStepLog<T>(label: string, timeoutMs: number, fn: () => Promise<T>): Promise<T | Failed> {
  const t0 = Date.now();
  console.error(`    ├─ ${label} 시작`);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Failed>((resolve) => {
    timer = setTimeout(() => resolve({ __failed: true, reason: `TIMEOUT ${timeoutMs}ms` }), timeoutMs);
  });
  try {
    const result = await Promise.race([fn(), timeout]);
    if (timer) clearTimeout(timer);
    const dt = Date.now() - t0;
    if (typeof result === 'object' && result !== null && '__failed' in result) {
      console.error(`    ├─ ${label} ✗ ${(result as Failed).reason} (${dt}ms)`);
    } else {
      console.error(`    ├─ ${label} ✓ (${dt}ms)`);
    }
    return result;
  } catch (err) {
    if (timer) clearTimeout(timer);
    const dt = Date.now() - t0;
    const msg = (err as Error).message ?? String(err);
    console.error(`    ├─ ${label} ✗ ERROR ${msg} (${dt}ms)`);
    return { __failed: true, reason: `ERROR ${msg}` };
  }
}

// information_schema.TABLES.TABLE_ROWS는 InnoDB에서 통계 기반 근사치라 부정확하므로
// 정확한 건수는 SELECT COUNT(*)로 직접 조회한다. 스키마 생성 시 1회만 실행된다.
const entries: Array<{
  name: string;
  count: number;
  columns: Array<{ name: string; type: string; nullable: string; key: string }>;
}> = [];

for (let i = 0; i < tables.length; i++) {
  const tableName = tables[i].TABLE_NAME as string;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`[${i + 1}/${tables.length}] (${elapsed}s) ${tableName}`);

  const countResult = await withStepLog(`COUNT(*) ${tableName}`, 15_000, async () => {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS row_count FROM \`${tableName.replace(/`/g, '``')}\``,
    );
    return Number(rows[0]?.row_count ?? 0);
  });
  const columnsResult = await withStepLog(`columns(${tableName})`, 15_000, async () => {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [DB_DATABASE, tableName],
    );
    return rows;
  });

  const rowCount = typeof countResult === 'number' ? countResult : -1;
  const columns = Array.isArray(columnsResult) ? columnsResult : [];

  entries.push({
    name: tableName,
    count: rowCount,
    columns: columns.map(col => ({
      name: col.COLUMN_NAME as string,
      type: col.COLUMN_TYPE as string,
      nullable: col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL',
      key: col.COLUMN_KEY ? ` ${col.COLUMN_KEY}` : '',
    })),
  });
}
console.error(`추출 완료 (총 ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

entries.sort((a, b) => b.count - a.count);

for (const { name, count, columns } of entries) {
  console.log(`[TABLE] ${name} | ${count}건`);
  for (const col of columns) {
    console.log(`  ${col.name}: ${col.type} ${col.nullable}${col.key}`);
  }
}

await conn.end();
