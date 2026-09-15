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
const cols = await db.listCollections().toArray();

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

const entries: Array<{ name: string; count: number; fields: Array<[string, string]> }> = [];

for (const col of cols) {
  const [count, sample] = await Promise.all([
    db.collection(col.name).estimatedDocumentCount(),
    db.collection(col.name).findOne({}, { projection: { password: 0, passHash: 0 } }),
  ]);
  const fields: Array<[string, string]> = sample
    ? Object.entries(sample)
        .filter(([k]) => k !== '_id')
        .slice(0, 20)
        .map(([k, v]) => [k, inferType(v)])
    : [];
  entries.push({ name: col.name, count, fields });
}

entries.sort((a, b) => b.count - a.count);

for (const { name, count, fields } of entries) {
  console.log(`[COLLECTION] ${name} | ${count}건`);
  for (const [field, type] of fields) {
    console.log(`  ${field}: ${type}`);
  }
}

await client.close();
