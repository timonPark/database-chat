#!/usr/bin/env node
// 자연어 조회 테스트케이스 실행기 — 실행 중인 템플릿 서버에 케이스를 보내 결과 컬럼 매칭을 판정한다.
// 의존성 없음 (Node 18+ 내장 fetch). mac · Windows 공통.
//
//   node docs/test-cases/run-cases.mjs --db mysql --url http://localhost:3111 --project ../my-app
//   node docs/test-cases/run-cases.mjs --db mssql --list            # 케이스 목록을 마크다운으로 출력
//
// 자세한 사용법 · 판정 기준은 docs/test-cases/README.md

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DBS = ['mysql', 'postgresql', 'oracle', 'mssql', 'mongodb'];

function parseArgs(argv) {
  const args = { url: null, only: null, skipChat: false, skipDirect: false, retry: 1, timeout: 300_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--db') args.db = next();
    else if (a === '--url') args.url = next();
    else if (a === '--project') args.project = next();
    else if (a === '--out') args.out = next();
    else if (a === '--only') args.only = new Set(next().split(',').map((s) => s.trim()));
    else if (a === '--skip-chat') args.skipChat = true;
    else if (a === '--skip-direct') args.skipDirect = true;
    else if (a === '--retry') args.retry = Number(next());
    else if (a === '--timeout') args.timeout = Number(next()) * 1000;
    else if (a === '--list') args.list = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  return args;
}

const HELP = `사용법: node docs/test-cases/run-cases.mjs --db <${DBS.join('|')}> [옵션]

  --url <url>        서버 주소 (기본: --project 의 .env PORT, 없으면 http://localhost:3111)
  --project <dir>    검증할 설치 폴더. SQL 허용 규칙(WITH) · 모델명 · 포트를 읽어 판정에 반영
  --out <file.md>    결과를 마크다운으로 저장
  --only <ids>       일부 케이스만 (예: D-01,TC-05)
  --skip-chat        자연어(/chat) 케이스 건너뛰기
  --skip-direct      직접 SQL(API) 케이스 건너뛰기
  --retry <n>        자연어 케이스가 LLM · DB 오류일 때 재시도 횟수 (기본 1)
  --timeout <sec>    요청당 제한 시간 (기본 300)
  --list             케이스 목록을 마크다운으로 출력하고 종료`;

// ── 설치 폴더 정보 ──────────────────────────────────────────────────────────

function readProject(dir) {
  const info = { dir: path.resolve(dir) };
  const serverPath = path.join(info.dir, 'server.ts');
  if (fs.existsSync(serverPath)) {
    const src = fs.readFileSync(serverPath, 'utf-8');
    const m = src.match(/ALLOWED_SQL_PREFIXES[^=]*=\s*\[([^\]]*)\]/);
    if (m) info.cteAllowed = /['"]WITH['"]/.test(m[1]);
  }
  const envPath = path.join(info.dir, '.env');
  if (fs.existsSync(envPath)) {
    // 접속 정보는 읽지 않는다 — PORT 와 모델명만
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const kv = line.match(/^\s*(PORT|CLAUDE_MODEL|CODEX_MODEL|GEMINI_MODEL)\s*=\s*(.*?)\s*$/);
      if (!kv) continue;
      if (kv[1] === 'PORT') info.port = kv[2];
      else info.model = kv[2];
    }
  }
  const pkgPath = path.join(info.dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const m = String(pkg.name ?? '').match(/(claude|codex|gemini)/);
      if (m) info.provider = m[1];
    } catch { /* ignore */ }
  }
  if (!info.provider) {
    const m = path.basename(info.dir).match(/(claude|codex|gemini)/);
    if (m) info.provider = m[1];
  }
  return info;
}

// ── 서버 호출 ───────────────────────────────────────────────────────────────

async function postJson(url, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = { error: `JSON 아닌 응답 (HTTP ${res.status})` };
  }
  return { status: res.status, body: json };
}

async function runDirect(c, ctx) {
  const endpoint = c.endpoint ?? '/db-query';
  const body = c.body ?? { sql: c.sql };
  return postJson(`${ctx.url}${endpoint}`, body, ctx.timeout);
}

async function runChat(c, ctx) {
  const res = await fetch(`${ctx.url}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: c.question, requestId: `run-cases-${c.id}-${Date.now()}` }),
    signal: AbortSignal.timeout(ctx.timeout),
  });
  const text = await res.text();
  const out = { query: null, result: null, errors: [] };
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    let ev;
    try {
      ev = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (ev.type === 'query') out.query = ev.data?.requestBody ?? null;
    else if (ev.type === 'result-data') out.result = ev.data;
    else if (ev.type === 'error') out.errors.push(ev.message);
  }
  if (res.status !== 200) out.errors.push(`HTTP ${res.status}`);
  return out;
}

// ── 판정 ────────────────────────────────────────────────────────────────────

const lc = (s) => String(s ?? '').toLowerCase();

function findColumn(columns, key) {
  return columns.find((col) => lc(col.key) === lc(key));
}

function keysOf(result) {
  const keys = new Set((result.columns ?? []).map((col) => lc(col.key)));
  for (const row of result.data ?? []) for (const k of Object.keys(row ?? {})) keys.add(lc(k));
  return keys;
}

// 자연어 케이스는 LLM 이 별칭 (c.name AS genre) 을 붙이거나 컬럼을 빼기도 하므로
// 같은 이름의 컬럼이 있을 때만 source 를 확인하고, 없으면 메모만 남긴다 (테이블 등장 여부는 judgeChat 에서 확인).
function checkCommon(exp, result, fail, review, isChat, note) {
  const columns = result.columns ?? [];
  if (exp.sources) {
    for (const [key, table] of Object.entries(exp.sources)) {
      const col = findColumn(columns, key);
      if (!col) {
        if (isChat) note(`${key} 컬럼 없음 (별칭 · 생략)`);
        else fail(`${key} 컬럼 없음 (기대 source ${table})`);
      } else if (lc(col.source) !== lc(table)) {
        fail(`${key}: source ${col.source ?? 'null(미매칭)'} (기대 ${table})`);
      }
    }
  }
  if (exp.absentKeys) {
    const keys = keysOf(result);
    for (const k of exp.absentKeys) if (keys.has(lc(k))) fail(`민감 컬럼 ${k} 가 결과에 노출됨`);
  }
  if (typeof exp.count === 'number' && result.count !== exp.count) {
    (isChat ? review : fail)(`count=${result.count} (기대 ${exp.count})`);
  }
}

function judgeDirect(c, res, ctx) {
  const notes = [];
  let status = 'PASS';
  const fail = (m) => { status = 'FAIL'; notes.push(m); };
  const review = (m) => { if (status === 'PASS') status = 'REVIEW'; notes.push(m); };
  const exp = c.expect;

  const denied = res.status === 400 && /허용/.test(res.body?.error ?? '');
  if (c.cte) {
    if (ctx.cteAllowed === false) {
      if (denied) return { status: 'PASS', notes: ['이 템플릿은 WITH 미허용 → 400 거부가 기대 결과'] };
      fail(`WITH 미허용 템플릿인데 HTTP ${res.status}`);
      return { status, notes };
    }
    if (denied) {
      if (ctx.cteAllowed === undefined) review('서버가 WITH 를 거부함 — --project 로 허용 규칙을 넘기면 자동 판정');
      else fail('WITH 허용 템플릿인데 400 거부');
      return { status, notes };
    }
  }
  if (res.status !== 200) {
    fail(`HTTP ${res.status} ${res.body?.error ?? ''}`.trim());
    return { status, notes };
  }

  const result = res.body;
  const columns = result.columns ?? [];
  if (exp.confidence && result.columnConfidence !== exp.confidence) {
    fail(`columnConfidence=${result.columnConfidence} (기대 ${exp.confidence})`);
  }
  if (exp.allFrom) {
    const wrong = columns.filter((col) => lc(col.source) !== lc(exp.allFrom));
    if (wrong.length) fail(`source 가 ${exp.allFrom} 가 아닌 컬럼: ${wrong.map((col) => `${col.key}→${col.source ?? 'null'}`).join(', ')}`);
  }
  if (exp.unmapped) {
    const got = (result.unmappedKeys ?? []).map(lc).sort().join(',');
    const want = exp.unmapped.map(lc).sort().join(',');
    if (got !== want) fail(`unmappedKeys=[${result.unmappedKeys}] (기대 [${exp.unmapped}])`);
  }
  if (exp.unmappedIncludes) {
    const got = new Set((result.unmappedKeys ?? []).map(lc));
    const missing = exp.unmappedIncludes.filter((k) => !got.has(lc(k)));
    if (missing.length) fail(`unmappedKeys 에 ${missing} 없음`);
  }
  if (exp.keys) {
    const got = columns.map((col) => lc(col.key)).sort().join(',');
    const want = exp.keys.map(lc).sort().join(',');
    if (got !== want) fail(`컬럼=[${columns.map((col) => col.key)}] (기대 [${exp.keys}])`);
  }
  checkCommon(exp, result, fail, review, false, (m) => notes.push(m));
  return { status, notes };
}

function judgeChat(c, out) {
  const notes = [];
  let status = 'PASS';
  const fail = (m) => { status = 'FAIL'; notes.push(m); };
  const review = (m) => { if (status === 'PASS') status = 'REVIEW'; notes.push(m); };
  const exp = c.expect;

  if (!out.result) {
    fail(`결과 없음 — ${out.errors.join(' / ') || '응답에 result-data 이벤트 없음'}`);
    return { status, notes };
  }
  const result = out.result;
  const columns = result.columns ?? [];
  const unmapped = result.unmappedKeys ?? [];

  if (exp.tables) {
    const allowed = new Set(exp.tables.map(lc));
    const wrong = columns.filter((col) => col.source && !allowed.has(lc(col.source)));
    if (wrong.length) fail(`예상 밖 테이블로 매칭: ${wrong.map((col) => `${col.key}→${col.source}`).join(', ')}`);
  }
  // sources 에 적힌 테이블은 (컬럼 이름이 별칭으로 바뀌어도) 매칭 결과에 한 번은 나와야 한다
  const required = [...new Set(Object.values(exp.sources ?? {}).map(lc))];
  const present = new Set(columns.map((col) => lc(col.source)));
  const absent = required.filter((t) => !present.has(t));
  if (absent.length) review(`${absent.join(', ')} 로 매칭된 컬럼 없음 — LLM 이 해당 테이블 컬럼을 조회하지 않았거나 계산 컬럼으로 바꿨는지 확인`);
  if (exp.confidence === 'full' && result.columnConfidence !== 'full') {
    if (exp.allowPartial) notes.push(`partial 허용 — ${exp.allowPartial}`);
    else review(`partial · 미매칭 [${unmapped}] — CONCAT · 집계 같은 계산 컬럼이면 정상, 스키마 컬럼이면 버그`);
  }
  if (exp.confidence === 'partial' && result.columnConfidence !== 'partial') {
    review('집계 질문인데 full — LLM 이 계산 컬럼 없이 조회했는지 SQL 확인');
  }
  checkCommon(exp, result, fail, review, true, (m) => notes.push(m));
  return { status, notes };
}

// ── 출력 ────────────────────────────────────────────────────────────────────

const ICON = { PASS: '✅', REVIEW: '⚠️', FAIL: '❌' };

function queryText(q) {
  if (!q) return '';
  if (typeof q.sql === 'string') return q.sql;
  if (q.pipeline) return `${q.collection}.aggregate(${JSON.stringify(q.pipeline)})`;
  if (q.collection) return `${q.collection}.find(${JSON.stringify(q.filter ?? {})}${q.projection ? `, ${JSON.stringify(q.projection)}` : ''})`;
  return JSON.stringify(q);
}

function caseQuery(c) {
  return c.sql ?? (c.body ? `${c.endpoint} ${JSON.stringify(c.body)}` : '');
}

const mdCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function columnsText(result) {
  return (result?.columns ?? []).map((col) => `${col.key}→${col.source ?? '미매칭'}`).join(', ');
}

function listMarkdown(spec) {
  const lines = [];
  lines.push(`# ${spec.db} 테스트케이스 — ${spec.sample.name}`);
  lines.push('');
  lines.push('> 이 파일은 `cases/' + spec.db + '.json` 에서 생성됩니다 (`node docs/test-cases/run-cases.mjs --db ' + spec.db + ' --list`). 직접 수정하지 말고 JSON 을 고친 뒤 다시 생성하세요.');
  lines.push('');
  lines.push(`- 샘플 데이터: ${spec.sample.seed}`);
  lines.push(`- 테이블: ${spec.sample.tables.map((t) => `\`${t}\``).join(', ')}`);
  for (const n of spec.notes ?? []) lines.push(`- ${n}`);
  lines.push('');
  lines.push('## 자연어 케이스 (`/chat`)');
  lines.push('');
  lines.push('| ID | 구분 | 질문 | 예상 쿼리 | 기대 |');
  lines.push('|---|---|---|---|---|');
  for (const c of spec.chat) {
    const e = c.expect;
    const parts = [`\`${e.confidence}\``];
    if (e.sources) parts.push(Object.entries(e.sources).map(([k, t]) => `${k}→${t}`).join(', '));
    if (e.tables) parts.push(`매칭 테이블 ⊂ {${e.tables.join(', ')}}`);
    if (e.absentKeys) parts.push(`${e.absentKeys.join(', ')} 미노출`);
    if (typeof e.count === 'number') parts.push(`${e.count}건`);
    if (e.allowPartial) parts.push(`partial 허용: ${e.allowPartial}`);
    lines.push(`| ${c.id} | ${c.category} | ${mdCell(c.question)} | ${c.expectedSql ? `\`${mdCell(c.expectedSql)}\`` : '—'} | ${mdCell(parts.join(' · '))} |`);
  }
  lines.push('');
  lines.push('## 직접 쿼리 케이스 (API)');
  lines.push('');
  lines.push('| ID | 구분 | 쿼리 | 기대 |');
  lines.push('|---|---|---|---|');
  for (const c of spec.direct) {
    const e = c.expect;
    const parts = [`\`${e.confidence}\``];
    if (e.allFrom) parts.push(`전 컬럼 source=${e.allFrom}`);
    if (e.sources) parts.push(Object.entries(e.sources).map(([k, t]) => `${k}→${t}`).join(', '));
    if (e.unmapped) parts.push(`미매칭 [${e.unmapped.join(', ')}]`);
    if (e.unmappedIncludes) parts.push(`미매칭에 ${e.unmappedIncludes.join(', ')} 포함`);
    if (e.keys) parts.push(`헤더 [${e.keys.join(', ')}]`);
    if (typeof e.count === 'number') parts.push(`${e.count}건`);
    if (e.absentKeys) parts.push(`${e.absentKeys.join(', ')} 미노출`);
    if (c.cte) parts.push('WITH 미허용 템플릿은 400 거부가 기대 결과');
    if (c.note) parts.push(c.note);
    lines.push(`| ${c.id} | ${c.category} | \`${mdCell(caseQuery(c))}\` | ${mdCell(parts.join(' · '))} |`);
  }
  return lines.join('\n') + '\n';
}

function reportMarkdown(spec, ctx, rows) {
  const count = (s) => rows.filter((r) => r.status === s).length;
  const lines = [];
  lines.push(`# ${spec.db} 테스트 결과`);
  lines.push('');
  lines.push(`- 실행: ${new Date().toISOString()} · OS: ${process.platform} · 서버: ${ctx.url}`);
  if (ctx.project) {
    lines.push(`- 설치 폴더: \`${ctx.project.dir}\` · provider: ${ctx.project.provider ?? '?'} · 모델: ${ctx.project.model ?? '?'} · WITH 허용: ${ctx.project.cteAllowed ?? '?'}`);
  }
  lines.push(`- 샘플 데이터: ${spec.sample.name}`);
  lines.push(`- 결과: ✅ ${count('PASS')} · ⚠️ ${count('REVIEW')} · ❌ ${count('FAIL')} (총 ${rows.length})`);
  lines.push('');
  lines.push('| ID | 구분 | 결과 | confidence | 미매칭 | 비고 |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(`| ${r.id} | ${r.category} | ${ICON[r.status]} | ${r.confidence ?? '—'} | ${mdCell((r.unmapped ?? []).join(', '))} | ${mdCell(r.notes.join(' / '))} |`);
  }
  lines.push('');
  lines.push('## 상세');
  lines.push('');
  for (const r of rows) {
    lines.push(`### ${r.id} ${ICON[r.status]} ${r.category}`);
    if (r.question) lines.push(`- 질문: ${r.question}`);
    if (r.query) lines.push(`- 실행 쿼리: \`${mdCell(r.query)}\``);
    lines.push(`- 컬럼: ${r.columns || '—'}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.db) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }
  if (!DBS.includes(args.db)) throw new Error(`--db 는 ${DBS.join(', ')} 중 하나`);
  const spec = JSON.parse(fs.readFileSync(path.join(HERE, 'cases', `${args.db}.json`), 'utf-8'));

  if (args.list) {
    process.stdout.write(listMarkdown(spec));
    return;
  }

  const project = args.project ? readProject(args.project) : null;
  const url = (args.url ?? (project?.port ? `http://localhost:${project.port}` : 'http://localhost:3111')).replace(/\/$/, '');
  const ctx = { url, timeout: args.timeout, cteAllowed: project?.cteAllowed, project };
  const pick = (c) => !args.only || args.only.has(c.id);

  console.log(`▶ ${args.db} · ${url}${project ? ` · ${project.provider ?? '?'} (${project.model ?? '모델 ?'}) · WITH 허용=${project.cteAllowed ?? '?'}` : ''}`);
  const rows = [];

  if (!args.skipDirect) {
    for (const c of spec.direct.filter(pick)) {
      let res;
      try {
        res = await runDirect(c, ctx);
      } catch (err) {
        res = { status: 0, body: { error: err.message } };
      }
      const { status, notes } = judgeDirect(c, res, ctx);
      rows.push({ id: c.id, category: c.category, status, notes, query: caseQuery(c), confidence: res.body?.columnConfidence, unmapped: res.body?.unmappedKeys, columns: columnsText(res.body) });
      console.log(`${ICON[status]} ${c.id.padEnd(6)} ${c.category}${notes.length ? `  — ${notes.join(' / ')}` : ''}`);
    }
  }

  if (!args.skipChat) {
    for (const c of spec.chat.filter(pick)) {
      let out;
      for (let attempt = 0; attempt <= args.retry; attempt += 1) {
        try {
          out = await runChat(c, ctx);
        } catch (err) {
          out = { query: null, result: null, errors: [err.message] };
        }
        if (out.result) break;
      }
      const { status, notes } = judgeChat(c, out);
      rows.push({ id: c.id, category: c.category, question: c.question, status, notes, query: queryText(out.query), confidence: out.result?.columnConfidence, unmapped: out.result?.unmappedKeys, columns: columnsText(out.result) });
      console.log(`${ICON[status]} ${c.id.padEnd(6)} ${c.category}  ${queryText(out.query).slice(0, 100)}${notes.length ? `\n         — ${notes.join(' / ')}` : ''}`);
    }
  }

  const summary = ['PASS', 'REVIEW', 'FAIL'].map((s) => `${ICON[s]} ${rows.filter((r) => r.status === s).length}`).join(' · ');
  console.log(`\n${summary} (총 ${rows.length})`);
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, reportMarkdown(spec, ctx, rows));
    console.log(`결과 저장: ${args.out}`);
  }
  process.exit(rows.some((r) => r.status === 'FAIL') ? 1 : 0);
}

main().catch((err) => {
  console.error(`오류: ${err.message}`);
  process.exit(2);
});
