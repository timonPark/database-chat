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

// SQL tables/<name>.md 라인 포맷: | `col_name` | type | NO/YES | PRI/MUL | 한글 설명 |
// 5-column (mongodb 는 3-column). Null · Key 는 스킵.
const FIELD_ROW_REGEX = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*[^|]+\|\s*[^|]*\|\s*([^|]+?)\s*\|/;
const FIELD_SECTION_HEADING = /^##\s+컬럼\s*목록/;
const NEXT_SECTION_HEADING = /^##\s+/;

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
    const match = line.match(FIELD_ROW_REGEX);
    if (!match) continue;
    const [, key, type, label] = match;
    fields.push({ key: key.trim(), type: type.trim(), label: label.trim() });
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

/**
 * Look up a table schema, refreshing from disk if the file has changed
 * since it was last cached. Returns undefined for missing or unparseable files.
 */
export function getSchema(tableName: string): TableSchema | undefined {
  if (!cachedDir) return undefined;

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
