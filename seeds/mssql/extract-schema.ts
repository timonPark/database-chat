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

const tablesResult = await pool.request().query<{ table_name: string; row_count: number }>(
  `SELECT s.name + '.' + t.name AS table_name, p.rows AS row_count
   FROM sys.tables t
   JOIN sys.schemas s ON s.schema_id = t.schema_id
   JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
   ORDER BY p.rows DESC`,
);

for (const table of tablesResult.recordset) {
  const colsResult = await pool.request()
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
  console.log(`[TABLE] ${table.table_name} | ${table.row_count}건`);
  for (const col of colsResult.recordset) {
    const nullable = col.is_nullable ? 'NULL' : 'NOT NULL';
    const key = col.is_pk ? ' PK' : '';
    console.log(`  ${col.column_name}: ${col.type_name} ${nullable}${key}`);
  }
}

await sql.close();
