#!/usr/bin/env tsx
import 'dotenv/config';
import { Pool } from 'pg';

const { DB_HOST, DB_PORT, DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD, DB_SCHEMA } = process.env;

if (!DB_DATABASE || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const targetSchema = DB_SCHEMA ?? 'public';
const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);
if (SYSTEM_SCHEMAS.has(targetSchema.toLowerCase())) {
  console.error(`대상 스키마(${targetSchema})는 시스템 스키마입니다. DB_SCHEMA를 사용자 스키마로 지정하세요.`);
  process.exit(1);
}

const pool = new Pool({
  host: DB_HOST ?? 'localhost',
  port: Number(DB_PORT ?? 5432),
  database: DB_DATABASE,
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
});

// BASE TABLE 만 대상. 뷰(정의 서브쿼리가 매 조회마다 실행)와 시스템 스키마(pg_catalog, information_schema) 제외.
const { rows: tables } = await pool.query<{ table_name: string; row_count: string }>(
  `SELECT t.table_name,
          COALESCE((SELECT reltuples::bigint
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relname = t.table_name AND n.nspname = t.table_schema
                      AND c.relkind = 'r'), 0)::text AS row_count
   FROM information_schema.tables t
   WHERE t.table_schema = $1
     AND t.table_type = 'BASE TABLE'
     AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
   ORDER BY row_count DESC`,
  [targetSchema],
);

console.error(`테이블 ${tables.length}개 발견 (schema=${targetSchema}, BASE TABLE 만)`);
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
    const { rows } = await pool.query<{
      column_name: string; data_type: string; is_nullable: string; constraint_type: string | null;
    }>(
      `SELECT c.column_name, c.data_type, c.is_nullable,
              (SELECT tc.constraint_type
               FROM information_schema.key_column_usage kcu
               JOIN information_schema.table_constraints tc
                 ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
               WHERE kcu.table_schema = $1 AND kcu.table_name = c.table_name
                 AND kcu.column_name = c.column_name
               ORDER BY CASE tc.constraint_type WHEN 'PRIMARY KEY' THEN 0 ELSE 1 END
               LIMIT 1) AS constraint_type
       FROM information_schema.columns c
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [targetSchema, table.table_name],
    );
    return rows;
  });

  const columns = Array.isArray(colsResult) ? colsResult : [];

  console.log(`[TABLE] ${table.table_name} | ${table.row_count}건`);
  for (const col of columns) {
    const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
    const key = col.constraint_type === 'PRIMARY KEY' ? ' PK' : col.constraint_type === 'FOREIGN KEY' ? ' FK' : '';
    console.log(`  ${col.column_name}: ${col.data_type} ${nullable}${key}`);
  }
}
console.error(`추출 완료 (총 ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

await pool.end();
