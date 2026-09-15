#!/usr/bin/env tsx
import 'dotenv/config';
import { Pool } from 'pg';

const { DB_HOST, DB_PORT, DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD } = process.env;

if (!DB_DATABASE || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const pool = new Pool({
  host: DB_HOST ?? 'localhost',
  port: Number(DB_PORT ?? 5432),
  database: DB_DATABASE,
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
});

const { rows: tables } = await pool.query<{ table_name: string; row_count: string }>(
  `SELECT table_name, row_count::text AS row_count
   FROM (
     SELECT t.table_name,
            COALESCE((SELECT reltuples::bigint FROM pg_class WHERE relname = t.table_name), 0) AS row_count
     FROM information_schema.tables t
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
   ) AS sub
   ORDER BY row_count DESC`,
);

for (const table of tables) {
  const { rows: columns } = await pool.query<{
    column_name: string; data_type: string; is_nullable: string; constraint_type: string | null;
  }>(
    `SELECT c.column_name, c.data_type, c.is_nullable,
            (SELECT tc.constraint_type
             FROM information_schema.key_column_usage kcu
             JOIN information_schema.table_constraints tc
               ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
             WHERE kcu.table_schema = 'public' AND kcu.table_name = c.table_name
               AND kcu.column_name = c.column_name
             ORDER BY CASE tc.constraint_type WHEN 'PRIMARY KEY' THEN 0 ELSE 1 END
             LIMIT 1) AS constraint_type
     FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = $1
     ORDER BY c.ordinal_position`,
    [table.table_name],
  );
  console.log(`[TABLE] ${table.table_name} | ${table.row_count}건`);
  for (const col of columns) {
    const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
    const key = col.constraint_type === 'PRIMARY KEY' ? ' PK' : col.constraint_type === 'FOREIGN KEY' ? ' FK' : '';
    console.log(`  ${col.column_name}: ${col.data_type} ${nullable}${key}`);
  }
}

await pool.end();
