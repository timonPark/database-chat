#!/usr/bin/env tsx
import 'dotenv/config';
import mysql from 'mysql2/promise';

const { DB_HOST, DB_PORT, DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD } = process.env;

if (!DB_DATABASE || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const conn = await mysql.createConnection({
  host: DB_HOST ?? 'localhost',
  port: Number(DB_PORT ?? 3306),
  database: DB_DATABASE,
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
});

const [tables] = await conn.query<mysql.RowDataPacket[]>(
  `SELECT TABLE_NAME, COALESCE(TABLE_ROWS, 0) AS row_count
   FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
   ORDER BY TABLE_ROWS DESC`,
  [DB_DATABASE],
);

for (const table of tables) {
  const [columns] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [DB_DATABASE, table.TABLE_NAME],
  );
  console.log(`[TABLE] ${table.TABLE_NAME} | ${table.row_count}건`);
  for (const col of columns) {
    const nullable = col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL';
    const key = col.COLUMN_KEY ? ` ${col.COLUMN_KEY}` : '';
    console.log(`  ${col.COLUMN_NAME}: ${col.COLUMN_TYPE} ${nullable}${key}`);
  }
}

await conn.end();
