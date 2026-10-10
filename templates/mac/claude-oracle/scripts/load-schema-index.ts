import fs from 'fs';
import path from 'path';

// SQL 계열 (mysql · postgresql · oracle · mssql) 공통 스키마 인덱스 로더.
// mongodb 판과 동일한 API 지만, 파싱 대상은 tables/<name>.md (SQL 5-column 포맷).

export interface FieldSchema {
  key: string;
  type: string;
  label: string;
}

export interface TableSchema {
  name: string;
  fields: FieldSchema[];
  byName: Map<string, FieldSchema>;
}

interface CacheEntry {
  mtimeMs: number;
  schema: TableSchema | null;
}

// SQL tables/<name>.md 라인 포맷 (LLM 에 따라 3-column · 5-column 등 다양):
// 3-column: | `col` | type | 설명 |
// 5-column: | `col` | type | Null | Key | 설명 |
// 파싱 전략: split 으로 셀 분리 → 첫 셀 (name), 둘째 셀 (type), 마지막 셀 (description) 사용.
// 중간 셀 수는 무관하게 처리 (LLM 이 어떤 포맷을 뽑아도 대응).
const FIELD_SECTION_HEADING = /^##\s+컬럼\s*목록/;
const NEXT_SECTION_HEADING = /^##\s+/;
const NAME_CELL_REGEX = /^`([^`]+)`$/;
const SEPARATOR_ROW_REGEX = /^\|[\s\-:|]+\|\s*$/;

function parseFieldRow(line: string): FieldSchema | null {
  // 표 행: |val1|val2|...|
  if (!line.startsWith('|') || !line.trimEnd().endsWith('|')) return null;
  if (SEPARATOR_ROW_REGEX.test(line)) return null; // | --- | --- | 같은 구분자 행 스킵
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  // 최소: name · type · description = 3 개 셀
  if (cells.length < 3) return null;

  const nameCell = cells[0];
  const typeCell = cells[1];
  const descCell = cells[cells.length - 1];

  const nameMatch = nameCell.match(NAME_CELL_REGEX);
  if (!nameMatch) return null; // 헤더 행 (| 컬럼명 | 타입 | 설명 |) 은 백틱 없어서 여기서 걸러짐

  return {
    key: nameMatch[1].trim(),
    type: typeCell,
    label: descCell,
  };
}

function parseSchemaFile(filePath: string, tableName: string): TableSchema | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  let inFieldSection = false;
  const fields: FieldSchema[] = [];

  for (const line of lines) {
    if (!inFieldSection) {
      if (FIELD_SECTION_HEADING.test(line)) inFieldSection = true;
      continue;
    }
    if (NEXT_SECTION_HEADING.test(line)) break;
    const field = parseFieldRow(line);
    if (field) fields.push(field);
  }

  if (fields.length === 0) return null;

  const byName = new Map<string, FieldSchema>();
  for (const f of fields) byName.set(f.key, f);
  return { name: tableName, fields, byName };
}

const cache = new Map<string, CacheEntry>();
let cachedDir: string | null = null;

function tableNameFromFile(fileName: string): string {
  return fileName.replace(/\.md$/, '');
}

export interface LoadResult {
  loaded: number;
  failed: number;
  total: number;
}

/**
 * Scan the tables directory once at boot and prime the cache.
 * Files that fail to parse are skipped (fallback rendering will use raw keys).
 */
export function loadAllSchemas(dir: string): LoadResult {
  cachedDir = dir;
  cache.clear();
  dirListing = null;

  if (!fs.existsSync(dir)) {
    return { loaded: 0, failed: 0, total: 0 };
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  let loaded = 0;
  let failed = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const tableName = tableNameFromFile(file);
    try {
      const stat = fs.statSync(filePath);
      const schema = parseSchemaFile(filePath, tableName);
      cache.set(tableName, { mtimeMs: stat.mtimeMs, schema });
      if (schema) loaded += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }

  return { loaded, failed, total: files.length };
}

interface DirListing {
  mtimeMs: number;
  names: string[];
}

let dirListing: DirListing | null = null;

function listTableNames(): string[] {
  if (!cachedDir) return [];
  try {
    const stat = fs.statSync(cachedDir);
    if (!dirListing || dirListing.mtimeMs !== stat.mtimeMs) {
      const names = fs.readdirSync(cachedDir).filter((f) => f.endsWith('.md')).map(tableNameFromFile);
      dirListing = { mtimeMs: stat.mtimeMs, names };
    }
    return dirListing.names;
  } catch {
    return [];
  }
}

/**
 * SQL 에 쓴 테이블 참조를 tables/ 의 파일 이름으로 해석.
 * 파일 이름은 DB 마다 다름 — MSSQL `dbo.comments` · PostgreSQL/MySQL `comments` · Oracle `COMMENTS`.
 * 참조도 `comments` · `dbo.comments` · `mydb.dbo.comments` · `public.comments` 등으로 다양하므로
 * 대소문자 무시 + 앞쪽 세그먼트를 하나씩 떼며 일치하는 파일을 찾는다.
 * 실제 존재하는 파일 이름만 반환하므로 SQL 의 임의 문자열이 그대로 path.join 에 들어가지 않는다.
 */
function resolveTableName(ref: string): string | undefined {
  const names = listTableNames();
  const segments = ref.split('.').map((seg) => seg.trim().toLowerCase()).filter((seg) => seg.length > 0);
  for (let i = 0; i < segments.length; i += 1) {
    const suffix = segments.slice(i).join('.');
    const exact = names.find((n) => n.toLowerCase() === suffix);
    if (exact) return exact;
    // 접두사 없는 참조 (`comments`) ↔ 스키마 접두사가 붙은 파일 (`dbo.comments`). 여러 개면 dbo 우선
    const qualified = names.filter((n) => n.toLowerCase().endsWith(`.${suffix}`));
    if (qualified.length > 0) {
      return qualified.find((n) => n.toLowerCase() === `dbo.${suffix}`) ?? [...qualified].sort()[0];
    }
  }
  return undefined;
}

/**
 * Look up a table schema, refreshing from disk if the file has changed
 * since it was last cached. Returns undefined for missing or unparseable files.
 * `ref` 는 SQL 에 쓴 테이블 참조 그대로 (스키마 접두사 · 대소문자 무관).
 */
export function getSchema(ref: string): TableSchema | undefined {
  if (!cachedDir) return undefined;

  const tableName = resolveTableName(ref);
  if (!tableName) return undefined;

  const filePath = path.join(cachedDir, `${tableName}.md`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    cache.delete(tableName);
    return undefined;
  }

  const entry = cache.get(tableName);
  if (entry && entry.mtimeMs === stat.mtimeMs) {
    return entry.schema ?? undefined;
  }

  try {
    const schema = parseSchemaFile(filePath, tableName);
    cache.set(tableName, { mtimeMs: stat.mtimeMs, schema });
    return schema ?? undefined;
  } catch {
    cache.set(tableName, { mtimeMs: stat.mtimeMs, schema: null });
    return undefined;
  }
}
