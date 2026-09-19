#!/usr/bin/env tsx
import 'dotenv/config';
import sql from 'mssql';

const { DB_HOST, DB_PORT, DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD } = process.env;

if (!DB_DATABASE || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const pool = await sql.connect({
  server: DB_HOST ?? 'localhost',
  port: Number(DB_PORT ?? 1433),
  database: DB_DATABASE,
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
  options: { trustServerCertificate: true },
});

// sys.tables 는 사용자 정의 테이블만 반환 (뷰는 sys.views, 시스템 오브젝트는 sys.system_objects).
// 안전장치로 sys/INFORMATION_SCHEMA 스키마는 명시적으로 제외한다.
const tablesResult = await pool.request().query<{ table_name: string; row_count: number }>(
  `SELECT s.name + '.' + t.name AS table_name, p.rows AS row_count
   FROM sys.tables t
   JOIN sys.schemas s ON s.schema_id = t.schema_id
   JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
   WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
   ORDER BY p.rows DESC`,
);

const tables = tablesResult.recordset;
console.error(`테이블 ${tables.length}개 발견 (sys.tables 기반, view/system 제외)`);
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

for (let i = 0; i < tables.length; i++) {
  const table = tables[i];
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`[${i + 1}/${tables.length}] (${elapsed}s) ${table.table_name}`);

  const colsResult = await withStepLog(`columns(${table.table_name})`, 15_000, async () => {
    const r = await pool.request()
      .input('tbl', sql.NVarChar, table.table_name)
      .query<{ column_name: string; type_name: string; is_nullable: boolean; is_pk: number }>(
        `SELECT c.name AS column_name,
                tp.name AS type_name,
                c.is_nullable,
                CASE WHEN ic.object_id IS NOT NULL THEN 1 ELSE 0 END AS is_pk
         FROM sys.columns c
         JOIN sys.types tp ON tp.user_type_id = c.user_type_id
         LEFT JOIN sys.index_columns ic
           ON ic.object_id = c.object_id AND ic.column_id = c.column_id AND ic.index_id = 1
         WHERE c.object_id = OBJECT_ID(@tbl)
         ORDER BY c.column_id`,
      );
    return r.recordset;
  });

  const columns = Array.isArray(colsResult) ? colsResult : [];

  console.log(`[TABLE] ${table.table_name} | ${table.row_count}건`);
  for (const col of columns) {
    const nullable = col.is_nullable ? 'NULL' : 'NOT NULL';
    const key = col.is_pk ? ' PK' : '';
    console.log(`  ${col.column_name}: ${col.type_name} ${nullable}${key}`);
  }
}
console.error(`추출 완료 (총 ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

await sql.close();
