import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import path from 'path';

const DB_HOST     = process.env.DB_HOST     ?? 'localhost';
const DB_PORT     = process.env.DB_PORT     ?? '27017';
const DB_DATABASE = process.env.DB_DATABASE ?? 'mydb';
const DB_USER     = process.env.DB_USER_NAME     ?? 'root';
const DB_PASS     = process.env.DB_USER_PASSWORD ?? 'changeme';

const MONGO_URI = `mongodb://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_DATABASE}?authSource=admin`;

interface SampleData {
  users:    Record<string, unknown>[];
  products: Record<string, unknown>[];
  orders:   Record<string, unknown>[];
}

async function seed(): Promise<void> {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_DATABASE);

  const dataPath = path.resolve(import.meta.dirname, '..', 'data', 'sample.json');
  const { users, products, orders } = JSON.parse(readFileSync(dataPath, 'utf-8')) as SampleData;

  const collections: Array<{ name: string; docs: Record<string, unknown>[] }> = [
    { name: 'users',    docs: users    },
    { name: 'products', docs: products },
    { name: 'orders',   docs: orders   },
  ];

  for (const { name, docs } of collections) {
    await db.collection(name).drop().catch(() => { /* 없으면 무시 */ });
    await db.collection(name).insertMany(docs);
    console.log(`✔  ${name}: ${docs.length}건 삽입 완료`);
  }

  console.log('\n샘플 데이터 마이그레이션 완료.');
  await client.close();
}

seed().catch((err: unknown) => {
  console.error('마이그레이션 실패:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
