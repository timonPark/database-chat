#!/usr/bin/env tsx
import 'dotenv/config';
import oracledb from 'oracledb';

const { DB_HOST, DB_PORT, DB_SERVICE_NAME, DB_USER_NAME, DB_USER_PASSWORD } = process.env;

if (!DB_SERVICE_NAME || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_SERVICE_NAME, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const SYSTEM_USERS = new Set(['SYS', 'SYSTEM', 'SYSAUX']);
if (SYSTEM_USERS.has(DB_USER_NAME.toUpperCase())) {
  console.error(`DB_USER_NAME(${DB_USER_NAME})은 시스템 계정입니다. 사용자 계정으로 다시 지정하세요.`);
  process.exit(1);
}

const conn = await oracledb.getConnection({
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
  connectString: `${DB_HOST ?? 'localhost'}:${DB_PORT ?? '1521'}/${DB_SERVICE_NAME}`,
});

// user_tables 는 접속 유저 소유 테이블만 반환 → SYS/SYSTEM/SYSAUX 스키마는 자연히 제외됨.
// 뷰는 user_views 라 별도로 조회하지 않는 한 포함되지 않음.
const tablesResult = await conn.execute<[string, number | null]>(
  `SELECT table_name, num_rows FROM user_tables ORDER BY num_rows DESC NULLS LAST`,
  [],
  { outFormat: oracledb.OUT_FORMAT_ARRAY },
);

const tables = tablesResult.rows ?? [];
console.error(`테이블 ${tables.length}개 발견 (user_tables 기반, view/system 제외)`);
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

// num_rows 는 DBMS_STATS 실행 전이면 NULL. 이 경우 COUNT(*) 로 실측.
async function resolveRowCount(tableName: string, stats: number | null): Promise<number> {
  if (stats !== null && stats > 0) return stats;
  const { rows } = await conn.execute<[number]>(
    `SELECT COUNT(*) FROM "${tableName}"`,
    [],
    { outFormat: oracledb.OUT_FORMAT_ARRAY },
  );
  return rows?.[0]?.[0] ?? 0;
}

for (let i = 0; i < tables.length; i++) {
  const [tableName, statsRowCount] = tables[i];
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`[${i + 1}/${tables.length}] (${elapsed}s) ${tableName}`);

  const countResult = await withStepLog(`row count(${tableName})`, 15_000, () =>
    resolveRowCount(tableName, statsRowCount),
  );
  const colsResult = await withStepLog(`columns(${tableName})`, 15_000, async () => {
    const r = await conn.execute<[string, string, string, string | null]>(
      `SELECT c.column_name, c.data_type, c.nullable,
              (SELECT 'PK' FROM user_cons_columns cc
               JOIN user_constraints uc ON cc.constraint_name = uc.constraint_name
               WHERE uc.constraint_type = 'P' AND cc.table_name = c.table_name
                 AND cc.column_name = c.column_name AND ROWNUM = 1) AS key_type
       FROM user_tab_columns c
       WHERE c.table_name = :1
       ORDER BY c.column_id`,
      [tableName],
      { outFormat: oracledb.OUT_FORMAT_ARRAY },
    );
    return r.rows ?? [];
  });

  const rowCount = typeof countResult === 'number' ? countResult : -1;
  const columns = Array.isArray(colsResult) ? colsResult : [];

  console.log(`[TABLE] ${tableName} | ${rowCount}건`);
  for (const [colName, dataType, nullable, keyType] of columns) {
    const nullStr = nullable === 'Y' ? 'NULL' : 'NOT NULL';
    const keyStr = keyType ? ` ${keyType}` : '';
    console.log(`  ${colName}: ${dataType} ${nullStr}${keyStr}`);
  }
}
console.error(`추출 완료 (총 ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

await conn.close();
