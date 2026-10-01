import type { TableSchema } from './load-schema-index.js';
import { getSchema } from './load-schema-index.js';
import type { SqlAnalysis } from './sql-analyze.js';

// SQL 응답의 rows 첫 doc keys 를 base table schema 에 매칭해 columns 배열 구성.
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

function columnFromSchemaField(key: string, schema: TableSchema): Column | null {
  const field = schema.byName.get(key);
  if (!field) return null;
  return {
    key,
    label: field.label,
    type: field.type,
    source: schema.name,
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

/**
 * SQL SELECT 결과 rows 에 대해 columns 배열을 조립.
 *
 * - rows 가 비어있고 base table schema 를 알면 → schema 순서대로 컬럼 노출 (빈 표 헤더 렌더용)
 * - JOIN 이 있거나 base table 스키마에 없는 key 가 있으면 → partial confidence
 * - base table 을 못 잡았거나 스키마가 없으면 → 전부 fallback (unknown), partial
 */
export function buildColumnsFromSql(
  rows: Record<string, unknown>[],
  analysis: SqlAnalysis,
): ColumnsResult {
  const baseTable = analysis.baseTable;
  const baseSchema = baseTable ? getSchema(baseTable) : undefined;

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
    const mapped = baseSchema ? columnFromSchemaField(key, baseSchema) : null;
    if (mapped) {
      columns.push(mapped);
    } else {
      columns.push(fallbackColumn(key));
      unmapped.push(key);
    }
  }

  const confidence: 'full' | 'partial' =
    analysis.hasJoin || unmapped.length > 0 || !baseSchema ? 'partial' : 'full';

  return { columns, columnConfidence: confidence, unmappedKeys: unmapped };
}
