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
  `SELECT TABLE_NAME
   FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
   ORDER BY TABLE_NAME`,
  [DB_DATABASE],
);

// information_schema.TABLES.TABLE_ROWS는 InnoDB에서 통계 기반 근사치라 부정확하므로
// 정확한 건수는 SELECT COUNT(*)로 직접 조회한다. 스키마 생성 시 1회만 실행된다.
const entries: Array<{
  name: string;
  count: number;
  columns: Array<{ name: string; type: string; nullable: string; key: string }>;
}> = [];

for (const table of tables) {
  const tableName = table.TABLE_NAME as string;
  const [countRows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS row_count FROM \`${tableName.replace(/`/g, '``')}\``,
  );
  const rowCount = Number(countRows[0]?.row_count ?? 0);

  const [columns] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [DB_DATABASE, tableName],
  );

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

entries.sort((a, b) => b.count - a.count);

for (const { name, count, columns } of entries) {
  console.log(`[TABLE] ${name} | ${count}건`);
  for (const col of columns) {
    console.log(`  ${col.name}: ${col.type} ${col.nullable}${col.key}`);
  }
}

await conn.end();
