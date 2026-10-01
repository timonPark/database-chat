#!/usr/bin/env tsx
/**
 * MySQL 카탈로그(information_schema)에서 테이블/컬럼/외래키를 조회해
 * Mermaid ER 다이어그램을 생성한다.
 *
 * 관계 정보는 information_schema.KEY_COLUMN_USAGE 의 REFERENCED_TABLE_NAME
 * 을 사용하므로 실제 FK 제약을 100% 반영한다 (heuristic 아님).
 * 결과는 프로젝트 루트의 `erd.mmd` 로 저장한다.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

const { DB_HOST, DB_PORT, DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD } = process.env;

if (!DB_DATABASE || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const OUTPUT_FILE = path.resolve('erd.mmd');

const conn = await mysql.createConnection({
  host: DB_HOST ?? 'localhost',
  port: Number(DB_PORT ?? 3306),
  database: DB_DATABASE,
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
});

// ── 테이블 목록 ────────────────────────────────────────────────────────────────
const [tables] = await conn.query<mysql.RowDataPacket[]>(
  `SELECT TABLE_NAME
   FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
   ORDER BY TABLE_NAME`,
  [DB_DATABASE],
);

if (tables.length === 0) {
  console.error(`테이블이 없습니다. DB_DATABASE=${DB_DATABASE} 를 확인하세요.`);
  process.exit(1);
}

console.error(`테이블 ${tables.length}개 발견`);

// ── 컬럼 정보 (테이블별 PK/FK 마킹) ─────────────────────────────────────────────
const [allCols] = await conn.query<mysql.RowDataPacket[]>(
  `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.COLUMN_KEY, c.ORDINAL_POSITION
   FROM information_schema.COLUMNS c
   WHERE c.TABLE_SCHEMA = ?
   ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
  [DB_DATABASE],
);

// ── FK 제약 ────────────────────────────────────────────────────────────────────
const [fks] = await conn.query<mysql.RowDataPacket[]>(
  `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
   FROM information_schema.KEY_COLUMN_USAGE
   WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
  [DB_DATABASE],
);

const fkColumns = new Set<string>(fks.map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`));

// ── Mermaid 생성 ───────────────────────────────────────────────────────────────
function sanitize(v: string): string {
  return v.replace(/[^A-Za-z0-9_]/g, '');
}
function sanitizeType(v: string): string {
  return v.replace(/[|`\\"']/g, '').replace(/[^A-Za-z0-9_\s\-.]/g, '').trim().split(/\s+/)[0] || 'unknown';
}

const colsByTable = new Map<string, mysql.RowDataPacket[]>();
for (const c of allCols) {
  const t = c.TABLE_NAME as string;
  if (!colsByTable.has(t)) colsByTable.set(t, []);
  colsByTable.get(t)!.push(c);
}

const lines: string[] = ['erDiagram'];

for (const t of tables) {
  const tableName = t.TABLE_NAME as string;
  const entityId = sanitize(tableName);
  lines.push(`  ${entityId} {`);
  const cols = colsByTable.get(tableName) ?? [];
  for (const c of cols) {
    const colName = c.COLUMN_NAME as string;
    const colType = c.DATA_TYPE as string;
    const isPk = c.COLUMN_KEY === 'PRI';
    const isFk = fkColumns.has(`${tableName}.${colName}`);
    const marker = isPk ? ' PK' : isFk ? ' FK' : '';
    const fName = sanitize(colName);
    const fType = sanitizeType(colType);
    if (!fName) continue;
    lines.push(`    ${fType} ${fName}${marker}`);
  }
  lines.push(`  }`);
}

// 관계: parent(||) --o{ child (부모의 PK를 자식이 FK로 참조)
const relationSet = new Set<string>();
for (const fk of fks) {
  const child = fk.TABLE_NAME as string;
  const parent = fk.REFERENCED_TABLE_NAME as string;
  if (!child || !parent) continue;
  relationSet.add(`${parent}|${child}`);
}
for (const rel of relationSet) {
  const [parent, child] = rel.split('|');
  lines.push(`  ${sanitize(parent)} ||--o{ ${sanitize(child)} : "refs"`);
}

console.error(`엔티티 ${tables.length}개, 관계 ${relationSet.size}개 (실 FK 기반)`);

const output = lines.join('\n') + '\n';
fs.writeFileSync(OUTPUT_FILE, output);
console.error(`erd.mmd 저장 완료 (${(output.length / 1024).toFixed(1)}KB)`);

await conn.end();
