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

function lastSegment(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1];
}

// SQL 에 적힌 테이블명 → tables/ 의 실제 파일명(확장자 제외).
// 정확한 이름 → schema.table ↔ table 양방향 → 대소문자 무시 순.
// (MSSQL 은 스키마 파일이 dbo.comments.md 인데 SQL 은 FROM comments · FROM dbo.comments 둘 다 가능)
function resolveTableName(dir: string, tableName: string): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map(tableNameFromFile).sort();
  } catch {
    return undefined;
  }

  const target = lastSegment(tableName);
  const matchers: ((name: string) => boolean)[] = [
    (name) => name === tableName,
    (name) => name === target,
    (name) => lastSegment(name) === target,
    (name) => name.toLowerCase() === tableName.toLowerCase(),
    (name) => name.toLowerCase() === target.toLowerCase(),
    (name) => lastSegment(name).toLowerCase() === target.toLowerCase(),
  ];
  for (const match of matchers) {
    const found = names.find(match);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Look up a table schema, refreshing from disk if the file has changed
 * since it was last cached. Returns undefined for missing or unparseable files.
 * tableName 은 SQL 에 적힌 그대로여도 된다 (resolveTableName 참고).
 */
export function getSchema(rawTableName: string): TableSchema | undefined {
  if (!cachedDir) return undefined;

  const tableName = resolveTableName(cachedDir, rawTableName);
  if (tableName === undefined) return undefined;

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
