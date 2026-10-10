import type { TableSchema } from './load-schema-index.js';
import { getSchema } from './load-schema-index.js';
import type { SqlAnalysis, TableRef } from './sql-analyze.js';

// SQL 응답의 rows keys 를 FROM · JOIN 테이블 스키마에 매칭해 columns 배열 구성.
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

function columnFromSchemaField(key: string, schema: TableSchema, fieldName: string = key): Column | null {
  // 정확한 이름 우선, 없으면 대소문자 무시 (Oracle 대문자 컬럼 · MSSQL case-insensitive collation)
  let field = schema.byName.get(fieldName);
  if (!field) {
    const lower = fieldName.toLowerCase();
    field = schema.fields.find((f) => f.key.toLowerCase() === lower);
  }
  if (!field) return null;
  return {
    key,
    label: field.label,
    type: field.type,
    source: schema.name,
  };
}

interface ResolvedTable {
  ref: TableRef;
  schema: TableSchema;
}

function resolveTables(analysis: SqlAnalysis): ResolvedTable[] {
  const resolved: ResolvedTable[] = [];
  // self-join 처럼 같은 테이블이 여러 별칭으로 나와도 별칭 조회가 되도록 ref 마다 유지 (탐색 순서는 mapKey 에서 dedupe)
  for (const ref of analysis.tables ?? []) {
    const schema = getSchema(ref.name);
    if (schema) resolved.push({ ref, schema });
  }
  return resolved;
}

// `c.text` 의 qualifier `c` 를 별칭 → 테이블명(전체 · 마지막 segment) 순으로 찾는다
function schemaForQualifier(qualifier: string, tables: ResolvedTable[]): TableSchema | undefined {
  const q = qualifier.toLowerCase();
  const byAlias = tables.find((t) => t.ref.alias?.toLowerCase() === q);
  if (byAlias) return byAlias.schema;
  const byName = tables.find((t) => {
    const name = t.ref.name.toLowerCase();
    return name === q || name.split('.').pop() === q;
  });
  return byName?.schema;
}

function uniqueSchemas(schemas: (TableSchema | undefined)[]): TableSchema[] {
  const out: TableSchema[] = [];
  for (const s of schemas) {
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function mapKey(key: string, analysis: SqlAnalysis, tables: ResolvedTable[]): Column | null {
  const lowerKey = key.toLowerCase();
  const item = (analysis.selectItems ?? []).find((it) => it.outputKey === key)
    ?? (analysis.selectItems ?? []).find((it) => it.outputKey.toLowerCase() === lowerKey);

  // 1) SELECT 목록에 c.col [AS key] 로 명시 → 해당 테이블의 원본 컬럼
  if (item?.qualifier) {
    const schema = schemaForQualifier(item.qualifier, tables);
    const mapped = schema ? columnFromSchemaField(key, schema, item.column) : null;
    if (mapped) return mapped;
  }

  // 2) SELECT c.* 처럼 별칭 명시된 테이블 → base → JOIN · 서브쿼리 테이블 순
  const starSchemas = (analysis.starQualifiers ?? []).map((q) => schemaForQualifier(q, tables));
  const ordered = uniqueSchemas([...starSchemas, ...tables.map((t) => t.schema)]);
  const fieldName = item ? item.column : key;
  for (const schema of ordered) {
    const mapped = columnFromSchemaField(key, schema, fieldName);
    if (mapped) return mapped;
  }
  return null;
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

/**
 * SQL SELECT 결과 rows 에 대해 columns 배열을 조립.
 *
 * - 결과 컬럼마다 SELECT 목록의 별칭 힌트 → base → JOIN · 서브쿼리 테이블 스키마 순으로 매칭
 * - rows 가 비어있고 base table schema 를 알면 → schema 순서대로 컬럼 노출 (빈 표 헤더 렌더용)
 * - 어느 스키마에도 없는 key 가 있거나 스키마를 하나도 못 찾으면 → partial confidence
 */
export function buildColumnsFromSql(
  rows: Record<string, unknown>[],
  analysis: SqlAnalysis,
): ColumnsResult {
  const tables = resolveTables(analysis);
  const baseSchema = tables.find((t) => t.ref === analysis.tables[0])?.schema;

  // 렌더할 key 목록 결정
  let keys: string[];
  if (rows.length > 0) {
    keys = collectRowKeys(rows);
  } else if (baseSchema) {
    keys = baseSchema.fields.map((f) => f.key);
  } else {
    keys = [];
  }

  const columns: Column[] = [];
  const unmapped: string[] = [];

  for (const key of keys) {
    const mapped = mapKey(key, analysis, tables);
    if (mapped) {
      columns.push(mapped);
    } else {
      columns.push(fallbackColumn(key));
      unmapped.push(key);
    }
  }

  const confidence: 'full' | 'partial' =
    unmapped.length > 0 || tables.length === 0 ? 'partial' : 'full';

  return { columns, columnConfidence: confidence, unmappedKeys: unmapped };
}
