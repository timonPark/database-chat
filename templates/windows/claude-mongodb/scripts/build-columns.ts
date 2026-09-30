import type { Document } from 'mongodb';
import type { CollectionSchema } from './load-schema-index.js';
import { getSchema } from './load-schema-index.js';
import type { PipelineAnalysis } from './pipeline-analyze.js';

export interface Column {
  key: string;
  label: string;
  type: string;
  source: string | null;
  sourcePath?: string;
}

export interface ColumnsResult {
  columns: Column[];
  columnConfidence: 'full' | 'partial';
  unmappedKeys: string[];
}

const SENSITIVE_KEYS = new Set<string>(['password', 'passHash']);

function fallbackColumn(key: string, sourcePath?: string): Column {
  return {
    key,
    label: key,
    type: 'unknown',
    source: null,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

function columnFromSchemaField(
  key: string,
  schema: CollectionSchema,
  fieldKey: string,
  sourcePath?: string,
): Column | null {
  const field = schema.byName.get(fieldKey);
  if (!field) return null;
  return {
    key,
    label: field.label,
    type: field.type,
    source: schema.name,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

function collectRowKeys(rows: Document[]): string[] {
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

function firstNonNullSample(rows: Document[], key: string): unknown {
  for (const row of rows) {
    const v = row?.[key];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function buildColumnsForCollection(
  keys: string[],
  collectionName: string,
  sourcePath?: string,
): { columns: Column[]; unmapped: string[] } {
  const schema = getSchema(collectionName);
  const columns: Column[] = [];
  const unmapped: string[] = [];

  const orderedKeys = schema && keys.length === 0
    ? schema.fields.map((f) => f.key)
    : keys;

  for (const key of orderedKeys) {
    if (SENSITIVE_KEYS.has(key)) continue;
    const mapped = schema ? columnFromSchemaField(key, schema, key, sourcePath) : null;
    if (mapped) {
      columns.push(mapped);
    } else {
      columns.push(fallbackColumn(key, sourcePath));
      unmapped.push(key);
    }
  }

  return { columns, unmapped };
}

/**
 * Build columns for a simple /db-query response.
 * When rows is empty, columns are derived entirely from the schema so the UI
 * can render an empty table with proper headers.
 */
export function buildColumnsFromQuery(
  collection: string,
  rows: Document[],
  projection: Record<string, unknown> | undefined,
): ColumnsResult {
  const schema = getSchema(collection);
  const hasProjection = projection && Object.values(projection).some((v) => v === 1 || v === true);
  const projectedKeys = hasProjection
    ? Object.keys(projection!).filter((k) => (projection![k] === 1 || projection![k] === true) && !SENSITIVE_KEYS.has(k))
    : null;

  let keys: string[];
  if (rows.length > 0) {
    keys = collectRowKeys(rows);
  } else if (projectedKeys && projectedKeys.length > 0) {
    keys = projectedKeys;
  } else if (schema) {
    keys = schema.fields.map((f) => f.key);
  } else {
    keys = [];
  }

  const { columns, unmapped } = buildColumnsForCollection(keys, collection);
  return {
    columns,
    columnConfidence: unmapped.length === 0 ? 'full' : 'partial',
    unmappedKeys: unmapped,
  };
}

/**
 * Build columns for an aggregation response using the pipeline analysis.
 * When shapeBroken is true, we still try to label root-level keys against the
 * base collection schema and mark unmatched keys as partial.
 */
export function buildColumnsFromPipeline(
  baseCollection: string,
  rows: Document[],
  analysis: PipelineAnalysis,
): ColumnsResult {
  const rootKeys = collectRowKeys(rows);
  const columns: Column[] = [];
  const unmapped: string[] = [];

  if (!analysis.shapeBroken) {
    // Group keys by which mapping path they belong to (base = "" or nested = "movie", "movie.director", ...)
    const paths = Array.from(analysis.pathToCollection.keys()).sort((a, b) => b.length - a.length);

    for (const key of rootKeys) {
      const nested = firstNonNullSample(rows, key);
      const isObject = nested !== null && typeof nested === 'object' && !Array.isArray(nested);
      const pathHere = paths.find((p) => p === key);

      if (pathHere && isObject) {
        const targetCollection = analysis.pathToCollection.get(pathHere)!;
        const schema = getSchema(targetCollection);
        const nestedKeys = collectRowKeys(rows.map((r) => r[key] as Document));
        for (const innerKey of nestedKeys) {
          const compoundKey = `${key}.${innerKey}`;
          const field = schema?.byName.get(innerKey);
          if (field) {
            columns.push({
              key: compoundKey,
              label: field.label,
              type: field.type,
              source: targetCollection,
              sourcePath: key,
            });
          } else {
            columns.push(fallbackColumn(compoundKey, key));
            unmapped.push(compoundKey);
          }
        }
      } else {
        const baseSchema = getSchema(baseCollection);
        const mapped = baseSchema ? columnFromSchemaField(key, baseSchema, key) : null;
        if (mapped) columns.push(mapped);
        else {
          columns.push(fallbackColumn(key));
          unmapped.push(key);
        }
      }
    }
  } else {
    // shapeBroken — best-effort label against base collection; unknown → raw key
    const baseSchema = getSchema(baseCollection);
    for (const key of rootKeys) {
      const mapped = baseSchema ? columnFromSchemaField(key, baseSchema, key) : null;
      if (mapped) columns.push(mapped);
      else {
        columns.push(fallbackColumn(key));
        unmapped.push(key);
      }
    }
  }

  const confidence: 'full' | 'partial' = analysis.shapeBroken || unmapped.length > 0 ? 'partial' : 'full';
  return { columns, columnConfidence: confidence, unmappedKeys: unmapped };
}
