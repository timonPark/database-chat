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

/**
 * Statically analyze an aggregation pipeline to derive:
 *   1) path-to-collection mapping (for $lookup nested paths)
 *   2) whether any stage broke the document shape (columns rendering must fallback)
 * Returns safe defaults for empty/missing pipelines.
 */
export function analyzePipeline(baseCollection: string, pipeline: Document[] | undefined | null): PipelineAnalysis {
  const pathToCollection = new Map<string, string>();
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

  walk(pipeline, '', pathToCollection, 0, markBreak);
  return { pathToCollection, shapeBroken, brokenAt };
}
