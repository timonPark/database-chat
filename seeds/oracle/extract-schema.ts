#!/usr/bin/env tsx
import 'dotenv/config';
import oracledb from 'oracledb';

const { DB_HOST, DB_PORT, DB_SERVICE_NAME, DB_USER_NAME, DB_USER_PASSWORD } = process.env;

if (!DB_SERVICE_NAME || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_SERVICE_NAME, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const conn = await oracledb.getConnection({
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
  connectString: `${DB_HOST ?? 'localhost'}:${DB_PORT ?? '1521'}/${DB_SERVICE_NAME}`,
});

const tablesResult = await conn.execute<[string, number | null]>(
  `SELECT table_name, num_rows FROM user_tables ORDER BY num_rows DESC NULLS LAST`,
  [],
  { outFormat: oracledb.OUT_FORMAT_ARRAY },
);

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

for (const [tableName, statsRowCount] of tablesResult.rows ?? []) {
  const rowCount = await resolveRowCount(tableName, statsRowCount);
  const colResult = await conn.execute<[string, string, string, string | null]>(
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
  console.log(`[TABLE] ${tableName} | ${rowCount}건`);
  for (const [colName, dataType, nullable, keyType] of colResult.rows ?? []) {
    const nullStr = nullable === 'Y' ? 'NULL' : 'NOT NULL';
    const keyStr = keyType ? ` ${keyType}` : '';
    console.log(`  ${colName}: ${dataType} ${nullStr}${keyStr}`);
  }
}

await conn.close();
