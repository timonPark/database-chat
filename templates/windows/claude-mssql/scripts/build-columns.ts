import type { FieldSchema, TableSchema } from './load-schema-index.js';
import { getSchema } from './load-schema-index.js';
import type { QueryInfo, SqlAnalysis, SqlSource } from './sql-analyze.js';

// SQL 응답의 rows keys 를 SELECT 목록 · FROM/JOIN 소스 테이블 스키마에 매칭해 columns 배열 구성.
// mongodb 판과 동일한 출력 shape (UI 는 mongodb · SQL 구분 없이 columns 배열만 렌더).

export interface Column {
  key: string;
  label: string;
  type: string;
  source: string | null;
}

export interface ColumnsResult {
  columns: Column[];
  columnConfidence: 'full' | 'partial';
  unmappedKeys: string[];
}

// 어떤 SQL DB 든 password · pwd · pass_hash 등 민감 컬럼은 클라이언트로 노출 금지.
// (테이블에 이런 컬럼이 있고 SELECT * 결과에 포함되어도 UI 컬럼에서 제외)
const SENSITIVE_KEYS = new Set<string>(['password', 'passHash', 'pass_hash', 'pwd']);

function fallbackColumn(key: string): Column {
  return {
    key,
    label: key,
    type: 'unknown',
    source: null,
  };
}

// 스키마 컬럼명은 LLM 이 쓴 대소문자 그대로라 결과 key (Oracle 은 대문자) 와 다를 수 있음 → 대소문자 무시 재시도
function findField(schema: TableSchema, name: string): FieldSchema | undefined {
  const exact = schema.byName.get(name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return schema.fields.find((f) => f.key.toLowerCase() === lower);
}

interface FieldHit {
  field: FieldSchema;
  schema: TableSchema;
}

const MAX_DEPTH = 8;

function resolveInSource(source: SqlSource, col: string, depth: number): FieldHit | null {
  if (source.sub) return resolveInQuery(source.sub, col, depth + 1);
  if (!source.table) return null;
  const schema = getSchema(source.table);
  const field = schema ? findField(schema, col) : undefined;
  return schema && field ? { field, schema } : null;
}

function firstHit(sources: SqlSource[], col: string, depth: number): FieldHit | null {
  for (const source of sources) {
    const hit = resolveInSource(source, col, depth);
    if (hit) return hit;
  }
  return null;
}

// `c.name` · `c.*` 의 qualifier 가 가리키는 소스 (별칭 또는 테이블명으로 매칭)
function sourcesFor(query: QueryInfo, qual: string): SqlSource[] {
  const qualLast = qual.split('.').pop();
  return query.sources.filter(
    (s) =>
      s.alias === qual ||
      (s.table !== null && (s.table.toLowerCase() === qual || s.table.toLowerCase().split('.').pop() === qualLast)),
  );
}

// 결과 key 가 어느 테이블의 어떤 컬럼에서 왔는지 SELECT 목록 → FROM/JOIN 소스 순으로 추적
function resolveInQuery(query: QueryInfo, key: string, depth: number): FieldHit | null {
  if (depth > MAX_DEPTH) return null;
  if (!query.items) return firstHit(query.sources, key, depth);

  const lower = key.toLowerCase();
  const item = query.items.find((it) => !it.star && it.key !== null && it.key.toLowerCase() === lower);
  if (item) {
    // 표현식 (COUNT(*) AS cnt 등) 은 스키마 컬럼이 아님
    if (!item.col) return null;
    return firstHit(item.qual ? sourcesFor(query, item.qual) : query.sources, item.col, depth);
  }

  for (const star of query.items.filter((it) => it.star)) {
    const hit = firstHit(star.qual ? sourcesFor(query, star.qual) : query.sources, key, depth);
    if (hit) return hit;
  }
  return null;
}

function columnFor(key: string, analysis: SqlAnalysis): Column | null {
  const hit = analysis.query ? resolveInQuery(analysis.query, key, 0) : null;
  if (!hit) return null;
  return {
    key,
    label: hit.field.label,
    type: hit.field.type,
    source: hit.schema.name,
  };
}

function collectRowKeys(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (SENSITIVE_KEYS.has(key)) continue;
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }
  return order;
}

// rows 가 비었을 때 헤더로 쓸 key 목록: SELECT 목록이 명시 컬럼뿐이면 그 순서, 아니면 기준 테이블 스키마 순서
function headerKeys(analysis: SqlAnalysis): string[] {
  const items = analysis.query?.items;
  if (items && items.length > 0 && items.every((it) => !it.star && it.key !== null)) {
    return items.map((it) => it.key as string).filter((key) => !SENSITIVE_KEYS.has(key));
  }
  const baseSchema = analysis.baseTableRef ? getSchema(analysis.baseTableRef) : undefined;
  return baseSchema ? baseSchema.fields.map((f) => f.key) : [];
}

/**
 * SQL SELECT 결과 rows 에 대해 columns 배열을 조립.
 *
 * - 각 key 는 SELECT 목록의 qualifier (alias.col · alias.*) 로 소스 테이블을 찾아 매칭.
 *   qualifier 가 없으면 FROM → JOIN 순서로 처음 매칭되는 테이블. CTE · 서브쿼리는 재귀 추적
 * - rows 가 비어있으면 → headerKeys 로 컬럼 노출 (빈 표 헤더 렌더용)
 * - 어느 스키마에도 없는 key (표현식 · 집계 등) 가 있거나 컬럼을 하나도 못 만들면 → partial confidence
 */
export function buildColumnsFromSql(
  rows: Record<string, unknown>[],
  analysis: SqlAnalysis,
): ColumnsResult {
  const keys = rows.length > 0 ? collectRowKeys(rows) : headerKeys(analysis);

  const columns: Column[] = [];
  const unmapped: string[] = [];

  for (const key of keys) {
    const mapped = columnFor(key, analysis);
    if (mapped) {
      columns.push(mapped);
    } else {
      columns.push(fallbackColumn(key));
      unmapped.push(key);
    }
  }

  const confidence: 'full' | 'partial' = unmapped.length > 0 || columns.length === 0 ? 'partial' : 'full';

  return { columns, columnConfidence: confidence, unmappedKeys: unmapped };
}
