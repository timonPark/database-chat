#!/usr/bin/env tsx
/**
 * Oracle 카탈로그(user_*)에서 테이블/컬럼/외래키를 조회해 Mermaid ER 다이어그램을 생성한다.
 *
 * 관계 정보는 user_constraints where CONSTRAINT_TYPE='R' + user_cons_columns
 * 조합으로 실제 FK 제약을 반영한다 (heuristic 아님).
 * 결과는 프로젝트 루트의 `erd.mmd` 로 저장한다.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import oracledb from 'oracledb';

const { DB_HOST, DB_PORT, DB_SERVICE_NAME, DB_USER_NAME, DB_USER_PASSWORD } = process.env;

if (!DB_SERVICE_NAME || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_SERVICE_NAME, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const OUTPUT_FILE = path.resolve('erd.mmd');

const conn = await oracledb.getConnection({
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
  connectString: `${DB_HOST ?? 'localhost'}:${DB_PORT ?? '1521'}/${DB_SERVICE_NAME}`,
});

// ── 테이블 목록 ────────────────────────────────────────────────────────────────
const tablesResult = await conn.execute<[string]>(
  `SELECT table_name FROM user_tables ORDER BY table_name`,
  [],
  { outFormat: oracledb.OUT_FORMAT_ARRAY },
);
const tables = (tablesResult.rows ?? []).map(([n]) => n);

if (tables.length === 0) {
  console.error(`user_tables에 테이블이 없습니다. DB_USER_NAME=${DB_USER_NAME} 을 확인하세요.`);
  process.exit(1);
}

console.error(`테이블 ${tables.length}개 발견`);

// ── 컬럼 정보 ──────────────────────────────────────────────────────────────────
const colsResult = await conn.execute<[string, string, string, number]>(
  `SELECT table_name, column_name, data_type, column_id
   FROM user_tab_columns
   ORDER BY table_name, column_id`,
  [],
  { outFormat: oracledb.OUT_FORMAT_ARRAY },
);
const allCols = colsResult.rows ?? [];

// ── PK 컬럼 ────────────────────────────────────────────────────────────────────
const pkResult = await conn.execute<[string, string]>(
  `SELECT cc.table_name, cc.column_name
   FROM user_cons_columns cc
   JOIN user_constraints uc ON uc.constraint_name = cc.constraint_name
   WHERE uc.constraint_type = 'P'`,
  [],
  { outFormat: oracledb.OUT_FORMAT_ARRAY },
);
const pkSet = new Set((pkResult.rows ?? []).map(([t, c]) => `${t}.${c}`));

// ── FK 제약 ────────────────────────────────────────────────────────────────────
// child.column → parent(table.column) 매핑. R 타입 constraint 의 R_CONSTRAINT_NAME 이
// 부모 쪽 PK/UK constraint 이름을 가리키므로, 다시 user_cons_columns 로 조인해 부모 테이블/컬럼을 찾는다.
const fkResult = await conn.execute<[string, string, string, string]>(
  `SELECT cc.table_name        AS child_table,
          cc.column_name       AS child_column,
          pcc.table_name       AS parent_table,
          pcc.column_name      AS parent_column
   FROM user_constraints uc
   JOIN user_cons_columns cc  ON cc.constraint_name  = uc.constraint_name
   JOIN user_cons_columns pcc ON pcc.constraint_name = uc.r_constraint_name AND pcc.position = cc.position
   WHERE uc.constraint_type = 'R'`,
  [],
  { outFormat: oracledb.OUT_FORMAT_ARRAY },
);
const fks = fkResult.rows ?? [];
const fkColumns = new Set(fks.map(([t, c]) => `${t}.${c}`));

// ── Mermaid 생성 ───────────────────────────────────────────────────────────────
function sanitize(v: string): string {
  return v.replace(/[^A-Za-z0-9_]/g, '');
}
function sanitizeType(v: string): string {
  return v.replace(/[|`\\"']/g, '').replace(/[^A-Za-z0-9_\s\-.]/g, '').trim().split(/\s+/)[0] || 'unknown';
}

const colsByTable = new Map<string, Array<[string, string]>>();
for (const [tName, cName, dType] of allCols) {
  if (!colsByTable.has(tName)) colsByTable.set(tName, []);
  colsByTable.get(tName)!.push([cName, dType]);
}

const lines: string[] = ['erDiagram'];

for (const tableName of tables) {
  const entityId = sanitize(tableName);
  lines.push(`  ${entityId} {`);
  const cols = colsByTable.get(tableName) ?? [];
  for (const [cName, dType] of cols) {
    const isPk = pkSet.has(`${tableName}.${cName}`);
    const isFk = fkColumns.has(`${tableName}.${cName}`);
    const marker = isPk ? ' PK' : isFk ? ' FK' : '';
    const fName = sanitize(cName);
    const fType = sanitizeType(dType);
    if (!fName) continue;
    lines.push(`    ${fType} ${fName}${marker}`);
  }
  lines.push(`  }`);
}

const relationSet = new Set<string>();
for (const [child, , parent] of fks) {
  if (!parent || !child) continue;
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

await conn.close();
