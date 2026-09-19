#!/usr/bin/env tsx
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const { DB_HOST, DB_PORT, DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD } = process.env;

if (!DB_DATABASE || !DB_USER_NAME || !DB_USER_PASSWORD) {
  console.error('필수 환경변수 누락: DB_DATABASE, DB_USER_NAME, DB_USER_PASSWORD');
  process.exit(1);
}

const uri = `mongodb://${DB_USER_NAME}:${DB_USER_PASSWORD}@${DB_HOST ?? 'localhost'}:${DB_PORT ?? '27017'}/${DB_DATABASE}?authSource=admin`;
const client = new MongoClient(uri, { maxPoolSize: 3 });
await client.connect();

const db = client.db(DB_DATABASE);
const allCols = await db.listCollections().toArray();

// view는 findOne이 언더라인 파이프라인을 실시간 실행해 매우 느리거나 무한대기하는 경우가 있어 제외한다.
// system.* 네임스페이스도 사용자 데이터가 아니므로 제외.
const cols = allCols.filter((c: { name: string; type?: string }) => {
  if (c.type === 'view') return false;
  if (c.name.startsWith('system.')) return false;
  return true;
});
const skipped = allCols.length - cols.length;

// 진행 상황은 stderr로 출력한다. stdout은 상위 셸에서 $(...) 로 캡쳐돼 프롬프트에 들어가기 때문.
console.error(`컬렉션 ${allCols.length}개 발견 (view/system ${skipped}개 제외 → ${cols.length}개 순회)`);
const startedAt = Date.now();

function inferType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (typeof value === 'object' && value !== null) {
    if ('_bsontype' in value) return (value as { _bsontype: string })._bsontype.toLowerCase();
    return 'object';
  }
  return typeof value;
}

// 단계별 타임아웃 래퍼. 어느 단계에서 얼마나 걸리는지 각각 stderr에 로깅한다.
type Failed = { __failed: true; reason: string };
async function withStepLog<T>(label: string, timeoutMs: number, fn: () => Promise<T>): Promise<T | Failed> {
  const t0 = Date.now();
  console.error(`    ├─ ${label} 시작`);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Failed>((resolve) => {
    timer = setTimeout(() => resolve({ __failed: true, reason: `TIMEOUT ${timeoutMs}ms` }), timeoutMs);
  });
  try {
    const result = await Promise.race([fn(), timeout]);
    if (timer) clearTimeout(timer);
    const dt = Date.now() - t0;
    if (typeof result === 'object' && result !== null && '__failed' in result) {
      console.error(`    ├─ ${label} ✗ ${(result as Failed).reason} (${dt}ms)`);
    } else {
      console.error(`    ├─ ${label} ✓ (${dt}ms)`);
    }
    return result;
  } catch (err) {
    if (timer) clearTimeout(timer);
    const dt = Date.now() - t0;
    const msg = (err as Error).message ?? String(err);
    console.error(`    ├─ ${label} ✗ ERROR ${msg} (${dt}ms)`);
    return { __failed: true, reason: `ERROR ${msg}` };
  }
}

const entries: Array<{ name: string; count: number; fields: Array<[string, string]> }> = [];

for (let i = 0; i < cols.length; i++) {
  const col = cols[i];
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const colType = (col as { type?: string }).type ?? 'unknown';
  console.error(`[${i + 1}/${cols.length}] (${elapsed}s) ${col.name} [type=${colType}]`);

  const countResult = await withStepLog(`estimatedDocumentCount(${col.name})`, 15_000, () =>
    db.collection(col.name).estimatedDocumentCount(),
  );
  const sampleResult = await withStepLog(`findOne(${col.name})`, 15_000, () =>
    db.collection(col.name).findOne({}, { projection: { password: 0, passHash: 0 } }),
  );

  const count = typeof countResult === 'number' ? countResult : -1;
  const sample = sampleResult && typeof sampleResult === 'object' && !('__failed' in sampleResult)
    ? sampleResult as Record<string, unknown>
    : null;

  const fields: Array<[string, string]> = sample
    ? Object.entries(sample)
        .filter(([k]) => k !== '_id')
        .slice(0, 20)
        .map(([k, v]) => [k, inferType(v)])
    : [];
  entries.push({ name: col.name, count, fields });
}
console.error(`추출 완료 (총 ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

entries.sort((a, b) => b.count - a.count);

for (const { name, count, fields } of entries) {
  console.log(`[COLLECTION] ${name} | ${count}건`);
  for (const [field, type] of fields) {
    console.log(`  ${field}: ${type}`);
  }
}

await client.close();
