#!/usr/bin/env tsx
/**
 * MSSQL 카탈로그(sys.*)에서 테이블/컬럼/외래키를 조회해 Mermaid ER 다이어그램을 생성한다.
 *
 * 관계 정보는 sys.foreign_keys + sys.foreign_key_columns 조합으로
 * 실제 FK 제약을 반영한다 (heuristic 아님).
 * 결과는 프로젝트 루트의 `erd.mmd` 로 저장한다.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import sql from 'mssql';

const { DB_HOST, DB_PORT, DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD } = process.env;

if (!DB_DATABASE || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const OUTPUT_FILE = path.resolve('erd.mmd');
const FIELD_LIMIT_PER_ENTITY = 12;

const pool = await sql.connect({
  server: DB_HOST ?? 'localhost',
  port: Number(DB_PORT ?? 1433),
  database: DB_DATABASE,
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
  options: { trustServerCertificate: true },
});

// ── 테이블 목록 ────────────────────────────────────────────────────────────────
const tablesResult = await pool.request().query<{ table_name: string }>(
  `SELECT s.name + '.' + t.name AS table_name
   FROM sys.tables t
   JOIN sys.schemas s ON s.schema_id = t.schema_id
   WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
   ORDER BY table_name`,
);
const tables = tablesResult.recordset;

if (tables.length === 0) {
  console.error(`sys.tables에 사용자 테이블이 없습니다. DB_DATABASE=${DB_DATABASE} 를 확인하세요.`);
  process.exit(1);
}

console.error(`테이블 ${tables.length}개 발견`);

// ── 컬럼 정보 + PK 마킹 ────────────────────────────────────────────────────────
const colsResult = await pool.request().query<{
  table_name: string; column_name: string; type_name: string; is_pk: number;
}>(
  `SELECT s.name + '.' + t.name AS table_name,
          c.name AS column_name,
          tp.name AS type_name,
          CASE WHEN ic.object_id IS NOT NULL AND i.is_primary_key = 1 THEN 1 ELSE 0 END AS is_pk
   FROM sys.tables t
   JOIN sys.schemas s ON s.schema_id = t.schema_id
   JOIN sys.columns c ON c.object_id = t.object_id
   JOIN sys.types tp ON tp.user_type_id = c.user_type_id
   LEFT JOIN sys.index_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
   LEFT JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND i.is_primary_key = 1
   WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
   ORDER BY table_name, c.column_id`,
);
const allCols = colsResult.recordset;

const pkSet = new Set(
  allCols.filter((c) => c.is_pk === 1).map((c) => `${c.table_name}.${c.column_name}`),
);

// ── FK 제약 ────────────────────────────────────────────────────────────────────
const fkResult = await pool.request().query<{
  child_table: string; child_column: string; parent_table: string; parent_column: string;
}>(
  `SELECT ss.name + '.' + st.name AS child_table,
          sc.name                 AS child_column,
          ps.name + '.' + pt.name AS parent_table,
          pc.name                 AS parent_column
   FROM sys.foreign_keys fk
   JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
   JOIN sys.tables  st ON st.object_id = fkc.parent_object_id
   JOIN sys.schemas ss ON ss.schema_id = st.schema_id
   JOIN sys.columns sc ON sc.object_id = fkc.parent_object_id AND sc.column_id = fkc.parent_column_id
   JOIN sys.tables  pt ON pt.object_id = fkc.referenced_object_id
   JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
   JOIN sys.columns pc ON pc.object_id = fkc.referenced_object_id AND pc.column_id = fkc.referenced_column_id`,
);
const fks = fkResult.recordset;
const fkColumns = new Set(fks.map((f) => `${f.child_table}.${f.child_column}`));

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
    const fType = sanitizeType(c.type_name);
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

await sql.close();
