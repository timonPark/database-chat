import type { Document } from 'mongodb';

export interface PipelineAnalysis {
  pathToCollection: Map<string, string>;
  shapeBroken: boolean;
  brokenAt: number | null;
}

const SHAPE_BREAKER_STAGES: ReadonlySet<string> = new Set([
  '$group',
  '$project',
  '$replaceRoot',
  '$replaceWith',
  '$addFields',
  '$set',
  '$bucket',
  '$bucketAuto',
  '$sortByCount',
]);

const CONFIDENCE_KILLER_STAGES: ReadonlySet<string> = new Set([
  '$facet',
  '$unionWith',
]);

const RECURSION_DEPTH_LIMIT = 8;

function stageName(stage: Document): string | undefined {
  return Object.keys(stage)[0];
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function walk(
  pipeline: Document[],
  prefix: string,
  pathToCollection: Map<string, string>,
  depth: number,
  markBreak: (stageIndex: number) => void,
): void {
  if (depth > RECURSION_DEPTH_LIMIT) return;
  for (let i = 0; i < pipeline.length; i += 1) {
    const stage = pipeline[i];
    const name = stageName(stage);
    if (!name) continue;

    if (name === '$lookup') {
      const spec = stage.$lookup as { from?: string; as?: string; pipeline?: Document[] } | undefined;
      if (spec && typeof spec.from === 'string' && typeof spec.as === 'string') {
        const nestedPrefix = joinPath(prefix, spec.as);
        pathToCollection.set(nestedPrefix, spec.from);
        if (Array.isArray(spec.pipeline)) {
          walk(spec.pipeline, nestedPrefix, pathToCollection, depth + 1, markBreak);
        }
      }
      continue;
    }

    if (SHAPE_BREAKER_STAGES.has(name) || CONFIDENCE_KILLER_STAGES.has(name)) {
      markBreak(i);
      // 계속 순회: 이후 stage 의 $lookup 매핑도 힌트로 기록 (fallback 렌더가 참고)
      continue;
    }

    // $unwind, $match, $sort, $limit, $skip, $count 등은 shape 유지
  }
}

// "$comment" 같은 필드 경로 → "comment", "$$ROOT" / "$$CURRENT" → "" (현재 루트).
// 그 밖의 변수 · 표현식 객체는 추적하지 않는다 (null).
function fieldPathRef(expr: unknown): string | null {
  if (expr === '$$ROOT' || expr === '$$CURRENT') return '';
  if (typeof expr !== 'string' || !expr.startsWith('$') || expr.startsWith('$$') || expr.length === 1) return null;
  return expr.slice(1);
}

// path 아래의 매핑을 newPrefix 아래로 옮긴 엔트리 목록. path 가 매핑에 없으면 null.
function rebaseEntries(map: Map<string, string>, path: string, newPrefix: string): Array<[string, string]> | null {
  if (!map.has(path)) return null;
  const entries: Array<[string, string]> = [];
  for (const [k, collection] of map) {
    if (k === path) entries.push([newPrefix, collection]);
    else if (path === '') entries.push([joinPath(newPrefix, k), collection]);
    else if (k.startsWith(`${path}.`)) entries.push([joinPath(newPrefix, k.slice(path.length + 1)), collection]);
  }
  return entries;
}

// $group 은 문서 형태를 바꾸지만, `{ k: { $first|$last: "$<lookup 경로>" } }` 처럼 lookup 문서를
// 그대로 넘기는 누산기는 컬렉션 매핑을 유지한다 (이후 $replaceRoot: "$k" 로 루트가 될 수 있음).
function carriedThroughGroup(spec: Record<string, unknown>, map: Map<string, string>): Map<string, string> {
  const next = new Map<string, string>();
  for (const [key, acc] of Object.entries(spec)) {
    const ref = key === '_id'
      ? fieldPathRef(acc)
      : acc !== null && typeof acc === 'object' && Object.keys(acc).length === 1
        ? fieldPathRef((acc as Record<string, unknown>).$first ?? (acc as Record<string, unknown>).$last)
        : null;
    const entries = ref !== null ? rebaseEntries(map, ref, key) : null;
    for (const [k, collection] of entries ?? []) next.set(k, collection);
  }
  return next;
}

/**
 * Statically analyze an aggregation pipeline to derive:
 *   1) path-to-collection mapping (for $lookup nested paths)
 *   2) whether any stage broke the document shape (columns rendering must fallback)
 * $replaceRoot / $replaceWith 가 lookup 경로로 루트를 바꾸면 그 컬렉션이 새 루트('')가 되고
 * 형태는 다시 확정된 것으로 본다.
 * Returns safe defaults for empty/missing pipelines.
 */
export function analyzePipeline(baseCollection: string, pipeline: Document[] | undefined | null): PipelineAnalysis {
  let pathToCollection = new Map<string, string>();
  pathToCollection.set('', baseCollection);

  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    return { pathToCollection, shapeBroken: false, brokenAt: null };
  }

  let shapeBroken = false;
  let brokenAt: number | null = null;
  const markBreak = (i: number): void => {
    if (!shapeBroken) {
      shapeBroken = true;
      brokenAt = i;
    }
  };

  for (let i = 0; i < pipeline.length; i += 1) {
    const stage = pipeline[i];
    const name = stageName(stage);
    if (!name) continue;

    if (name === '$replaceRoot' || name === '$replaceWith') {
      const expr = name === '$replaceRoot'
        ? (stage.$replaceRoot as { newRoot?: unknown } | undefined)?.newRoot
        : stage.$replaceWith;
      const ref = fieldPathRef(expr);
      if (ref === '') continue;
      const entries = ref !== null ? rebaseEntries(pathToCollection, ref, '') : null;
      if (entries) {
        pathToCollection = new Map(entries);
        shapeBroken = false;
        brokenAt = null;
      } else {
        markBreak(i);
      }
      continue;
    }

    if (name === '$group') {
      pathToCollection = carriedThroughGroup(stage.$group as Record<string, unknown>, pathToCollection);
      markBreak(i);
      continue;
    }

    walk([stage], '', pathToCollection, 0, () => markBreak(i));
  }

  return { pathToCollection, shapeBroken, brokenAt };
}
