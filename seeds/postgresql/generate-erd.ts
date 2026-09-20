#!/usr/bin/env tsx
/**
 * PostgreSQL 카탈로그(information_schema)에서 테이블/컬럼/외래키를 조회해
 * Mermaid ER 다이어그램을 생성한다.
 *
 * 관계 정보는 information_schema.referential_constraints + key_column_usage
 * 조합으로 실제 FK 제약을 반영한다 (heuristic 아님).
 * 결과는 프로젝트 루트의 `erd.mmd` 로 저장한다.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const { DB_HOST, DB_PORT, DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD, DB_SCHEMA } = process.env;

if (!DB_DATABASE || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const targetSchema = DB_SCHEMA ?? 'public';
const OUTPUT_FILE = path.resolve('erd.mmd');
const FIELD_LIMIT_PER_ENTITY = 12;

const pool = new Pool({
  host: DB_HOST ?? 'localhost',
  port: Number(DB_PORT ?? 5432),
  database: DB_DATABASE,
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
});

// ── 테이블 목록 ────────────────────────────────────────────────────────────────
const { rows: tables } = await pool.query<{ table_name: string }>(
  `SELECT table_name
   FROM information_schema.tables
   WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     AND table_schema NOT IN ('pg_catalog', 'information_schema')
   ORDER BY table_name`,
  [targetSchema],
);

if (tables.length === 0) {
  console.error(`테이블이 없습니다. schema=${targetSchema}`);
  process.exit(1);
}

console.error(`테이블 ${tables.length}개 발견 (schema=${targetSchema})`);

// ── 컬럼 정보 + PK 마킹 ────────────────────────────────────────────────────────
const { rows: allCols } = await pool.query<{
  table_name: string; column_name: string; data_type: string; ordinal_position: number;
}>(
  `SELECT c.table_name, c.column_name, c.data_type, c.ordinal_position
   FROM information_schema.columns c
   WHERE c.table_schema = $1
   ORDER BY c.table_name, c.ordinal_position`,
  [targetSchema],
);

const { rows: pkRows } = await pool.query<{ table_name: string; column_name: string }>(
  `SELECT kcu.table_name, kcu.column_name
   FROM information_schema.table_constraints tc
   JOIN information_schema.key_column_usage kcu
     ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
   WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'`,
  [targetSchema],
);
const pkSet = new Set(pkRows.map((r) => `${r.table_name}.${r.column_name}`));

// ── FK 제약 ────────────────────────────────────────────────────────────────────
const { rows: fks } = await pool.query<{
  child_table: string; child_column: string; parent_table: string; parent_column: string;
}>(
  `SELECT
     kcu.table_name       AS child_table,
     kcu.column_name      AS child_column,
     ccu.table_name       AS parent_table,
     ccu.column_name      AS parent_column
   FROM information_schema.referential_constraints rc
   JOIN information_schema.key_column_usage kcu
     ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema
   JOIN information_schema.constraint_column_usage ccu
     ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.unique_constraint_schema
   WHERE rc.constraint_schema = $1`,
  [targetSchema],
);

const fkColumns = new Set<string>(fks.map((r) => `${r.child_table}.${r.child_column}`));

// ── Mermaid 생성 ───────────────────────────────────────────────────────────────
function sanitize(v: string): string {
  return v.replace(/[^A-Za-z0-9_]/g, '');
}
function sanitizeType(v: string): string {
  return v.replace(/[|`\\"']/g, '').replace(/[^A-Za-z0-9_\s\-.]/g, '').trim().split(/\s+/)[0] || 'unknown';
}

const colsByTable = new Map<string, typeof allCols>();
for (const c of allCols) {
  if (!colsByTable.has(c.table_name)) colsByTable.set(c.table_name, []);
  colsByTable.get(c.table_name)!.push(c);
}

const lines: string[] = ['erDiagram'];

for (const t of tables) {
  const entityId = sanitize(t.table_name);
  lines.push(`  ${entityId} {`);
  const cols = (colsByTable.get(t.table_name) ?? []).slice(0, FIELD_LIMIT_PER_ENTITY);
  for (const c of cols) {
    const isPk = pkSet.has(`${t.table_name}.${c.column_name}`);
    const isFk = fkColumns.has(`${t.table_name}.${c.column_name}`);
    const marker = isPk ? ' PK' : isFk ? ' FK' : '';
    const fName = sanitize(c.column_name);
    const fType = sanitizeType(c.data_type);
    if (!fName) continue;
    lines.push(`    ${fType} ${fName}${marker}`);
  }
  const totalCols = colsByTable.get(t.table_name)?.length ?? 0;
  if (totalCols > FIELD_LIMIT_PER_ENTITY) {
    lines.push(`    string more_omitted "${totalCols - FIELD_LIMIT_PER_ENTITY}개 컬럼 생략"`);
  }
  lines.push(`  }`);
}

const relationSet = new Set<string>();
for (const fk of fks) {
  if (!fk.parent_table || !fk.child_table) continue;
  relationSet.add(`${fk.parent_table}|${fk.child_table}`);
}
for (const rel of relationSet) {
  const [parent, child] = rel.split('|');
  lines.push(`  ${sanitize(parent)} ||--o{ ${sanitize(child)} : "refs"`);
}

console.error(`엔티티 ${tables.length}개, 관계 ${relationSet.size}개 (실 FK 기반)`);

const output = lines.join('\n') + '\n';
fs.writeFileSync(OUTPUT_FILE, output);
console.error(`erd.mmd 저장 완료 (${(output.length / 1024).toFixed(1)}KB)`);

await pool.end();
