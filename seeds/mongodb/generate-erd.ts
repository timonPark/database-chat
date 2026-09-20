#!/usr/bin/env tsx
/**
 * collections/*.md 를 파싱해 Mermaid ER 다이어그램을 생성한다.
 *
 * 관계 추론 규칙 (MongoDB엔 FK 제약이 없어 heuristic 사용):
 * 1) 각 .md 의 `## 관련 컬렉션` 섹션에 백틱으로 감싼 컬렉션명이 있으면 관계로 채택
 * 2) 필드명이 `*Obj` / `*ObjectId` 로 끝나면 prefix 를 도메인 이름으로 취급하고,
 *    prefix 로 시작하는 collection 이 존재하면 관계로 채택 (예: patientObj → patient_model)
 *
 * 결과는 프로젝트 루트의 `erd.mmd` 로 저장한다. 서버가 이 파일을 읽어 UI 에 전달.
 */
import fs from 'fs';
import path from 'path';

const COLLECTIONS_DIR = path.resolve('collections');
const OUTPUT_FILE = path.resolve('erd.mmd');

interface Entity {
  name: string;
  fields: Array<{ name: string; type: string }>;
  relatedFromDoc: Set<string>; // "## 관련 컬렉션" 에서 뽑은 이름
}

if (!fs.existsSync(COLLECTIONS_DIR)) {
  console.error(`collections/ 디렉토리를 찾을 수 없습니다: ${COLLECTIONS_DIR}`);
  console.error(`먼저 pnpm run schema 를 실행해 컬렉션 스키마 문서를 생성하세요.`);
  process.exit(1);
}

const files: string[] = fs.readdirSync(COLLECTIONS_DIR)
  .filter((f: string) => f.endsWith('.md'))
  .sort();

if (files.length === 0) {
  console.error(`collections/*.md 파일이 없습니다. 먼저 pnpm run schema 를 실행하세요.`);
  process.exit(1);
}

console.error(`컬렉션 ${files.length}개 파싱 시작`);

// ── 파싱 ──────────────────────────────────────────────────────────────────────

function parseEntity(filePath: string): Entity {
  const name: string = path.basename(filePath, '.md');
  const content: string = fs.readFileSync(filePath, 'utf-8');

  // 필드 파싱: `## 필드 목록` ~ 다음 `##` 사이의 `| \`field\` | type | ... |` 라인
  const fields: Array<{ name: string; type: string }> = [];
  const fieldSection: RegExpMatchArray | null = content.match(/##\s*필드\s*목록[\s\S]*?(?=##|$)/);
  if (fieldSection) {
    const rowRe: RegExp = /^\|\s*`?([\w.]+)`?\s*\|\s*([^|]+?)\s*\|/gm;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(fieldSection[0])) !== null) {
      const fname: string = m[1].trim();
      const ftype: string = m[2].trim();
      if (fname === '필드명' || fname === '----' || fname.startsWith('-')) continue;
      fields.push({ name: fname, type: ftype });
    }
  }

  // 관련 컬렉션 파싱: `## 관련 컬렉션` 섹션의 백틱 안 이름들
  const relatedFromDoc: Set<string> = new Set();
  const relSection: RegExpMatchArray | null = content.match(/##\s*관련\s*컬렉션[\s\S]*?(?=##|$)/);
  if (relSection) {
    const backtickRe: RegExp = /`([a-z0-9_]+)`/gi;
    let m: RegExpExecArray | null;
    while ((m = backtickRe.exec(relSection[0])) !== null) {
      const n: string = m[1];
      if (n !== name) relatedFromDoc.add(n);
    }
  }

  return { name, fields, relatedFromDoc };
}

const entities: Entity[] = files.map((f: string) => parseEntity(path.join(COLLECTIONS_DIR, f)));
const entityNames: Set<string> = new Set(entities.map((e) => e.name));

// ── 관계 추론 ─────────────────────────────────────────────────────────────────

// prefix → 후보 collection 이름들. 예: "patient" → ["patient_model", "patient_test", ...]
const prefixIndex: Map<string, string[]> = new Map();
for (const n of entityNames) {
  const parts: string[] = n.split('_');
  for (let i = 1; i <= parts.length; i++) {
    const prefix: string = parts.slice(0, i).join('_');
    if (!prefixIndex.has(prefix)) prefixIndex.set(prefix, []);
    prefixIndex.get(prefix)!.push(n);
  }
}

function toSnake(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

function inferFromField(fieldName: string): string | null {
  // `patientObj` → prefix = "patient", "*ObjectId" 도 동일
  const m: RegExpMatchArray | null = fieldName.match(/^(.+?)(Obj|ObjectId|Id)$/);
  if (!m) return null;
  const raw: string = m[1];
  if (!raw || raw === '_') return null;
  const prefixSnake: string = toSnake(raw);
  // 정확 일치 우선
  if (entityNames.has(prefixSnake)) return prefixSnake;
  // prefix 로 시작하는 후보 검색
  const candidates: string[] | undefined = prefixIndex.get(prefixSnake);
  if (candidates && candidates.length === 1) return candidates[0];
  // 여러 후보면 가장 짧은 이름 (예: user_model)
  if (candidates && candidates.length > 1) {
    return [...candidates].sort((a, b) => a.length - b.length)[0];
  }
  return null;
}

// 최종 관계 셋: "from -> to" (중복 제거)
const relations: Set<string> = new Set();
for (const e of entities) {
  for (const target of e.relatedFromDoc) {
    if (entityNames.has(target)) relations.add(`${e.name}|${target}`);
  }
  for (const f of e.fields) {
    const target: string | null = inferFromField(f.name);
    if (target && target !== e.name) relations.add(`${e.name}|${target}`);
  }
}

console.error(`엔티티 ${entities.length}개, 관계 ${relations.size}개 추론`);

// ── Mermaid 문자열 생성 ───────────────────────────────────────────────────────

// 필드 이름/타입에서 mermaid 파서를 깨뜨리는 문자 제거
function sanitize(v: string): string {
  return v.replace(/[^A-Za-z0-9_]/g, '');
}

function sanitizeType(v: string): string {
  return v.replace(/[|`\\"']/g, '').replace(/[^A-Za-z0-9_\s\-.]/g, '').trim().split(/\s+/)[0] || 'unknown';
}

const FIELD_LIMIT_PER_ENTITY: number = 12;

const lines: string[] = ['erDiagram'];

for (const e of entities) {
  const entityId: string = sanitize(e.name);
  lines.push(`  ${entityId} {`);
  const shownFields = e.fields.slice(0, FIELD_LIMIT_PER_ENTITY);
  for (const f of shownFields) {
    const fName: string = sanitize(f.name);
    const fType: string = sanitizeType(f.type);
    if (!fName) continue;
    const isPk: boolean = fName === '_id' || fName === 'objectId';
    const isFk: boolean = /^(.+?)(Obj|ObjectId|Id)$/.test(f.name) && !isPk;
    const marker: string = isPk ? ' PK' : isFk ? ' FK' : '';
    lines.push(`    ${fType} ${fName}${marker}`);
  }
  if (e.fields.length > FIELD_LIMIT_PER_ENTITY) {
    lines.push(`    string more_omitted "${e.fields.length - FIELD_LIMIT_PER_ENTITY}개 필드 생략"`);
  }
  lines.push(`  }`);
}

for (const rel of relations) {
  const [from, to] = rel.split('|');
  lines.push(`  ${sanitize(from)} }o--|| ${sanitize(to)} : "refs"`);
}

const output: string = lines.join('\n') + '\n';
fs.writeFileSync(OUTPUT_FILE, output);
console.error(`erd.mmd 저장 완료 (${(output.length / 1024).toFixed(1)}KB)`);
