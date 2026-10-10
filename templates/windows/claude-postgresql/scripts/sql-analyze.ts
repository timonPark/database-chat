// LLM 이 뱉은 SELECT 문에서 결과 컬럼 매칭에 필요한 구조 (SELECT 항목 · FROM/JOIN 소스) 를 추출.
// AST 라이브러리 없이 경량 토크나이저로 defensive 하게 파싱. 파싱 실패해도 서버 실행에는 영향 없음
// (컬럼 라벨링만 partial 로 떨어짐).
//
// 처리 대상:
// - 식별자 따옴표: [dbo].[t] · `t` · "t"
// - 스키마 접두사: dbo.t · public.t · mydb.t (스키마 파일 이름 해석은 load-schema-index 가 담당)
// - JOIN · 콤마 조인 · APPLY: 모든 소스 테이블을 별칭과 함께 수집
// - CTE (WITH ...) · FROM 절 서브쿼리: 해당 쿼리를 재귀 분석해 실제 테이블까지 따라감

export interface SelectItem {
  star: boolean;
  // `alias.*` · `alias.col` 의 qualifier (소문자). 없으면 null
  qual: string | null;
  // 결과 행의 key 가 될 이름 (별칭 우선). star 이거나 별칭 없는 표현식이면 null
  key: string | null;
  // 단순 컬럼 참조면 원본 컬럼명, 표현식이면 null
  col: string | null;
}

export interface SqlSource {
  // FROM/JOIN 에 쓴 테이블명 (따옴표 제거, 스키마 접두사 유지). 서브쿼리 · CTE · 테이블 함수면 null
  table: string | null;
  // 서브쿼리 · CTE 참조면 그 쿼리 분석 결과
  sub: QueryInfo | null;
  // 별칭 (소문자). 테이블에 별칭이 없으면 테이블명 마지막 세그먼트
  alias: string | null;
}

export interface QueryInfo {
  // SELECT 목록. 파싱 못 하면 null
  items: SelectItem[] | null;
  // FROM · JOIN 소스 (등장 순서, 첫 원소가 FROM 기준 테이블)
  sources: SqlSource[];
}

export interface SqlAnalysis {
  // 최상위 쿼리의 기준 테이블 (스키마 접두사 제외). 엑셀 내보내기 이름 등 표시용
  baseTable: string | null;
  // 기준 테이블 (스키마 접두사 포함). 스키마 조회용
  baseTableRef: string | null;
  hasJoin: boolean;
  query: QueryInfo | null;
}

interface Token {
  t: 'id' | 'qid' | 'str' | 'num' | 'p';
  v: string;
  u: string;
}

// 테이블 · SELECT 항목 별칭으로 오인하면 안 되는 예약어
const RESERVED = new Set<string>([
  'ON', 'USING', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT',
  'EXCEPT', 'MINUS', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'WINDOW',
  'FOR', 'WITH', 'START', 'CONNECT', 'QUALIFY', 'RETURNING', 'INTO', 'FROM', 'SELECT', 'AS', 'END',
  'PIVOT', 'UNPIVOT', 'TABLESAMPLE', 'APPLY', 'LATERAL', 'STRAIGHT_JOIN', 'PARTITION', 'SAMPLE', 'NULL',
  'AND', 'OR', 'NOT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'ASC', 'DESC', 'USE', 'FORCE', 'IGNORE', 'OPTION',
]);

// 최상위 FROM 절 스캔을 멈추는 절 키워드
const CLAUSE_END = new Set<string>([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS',
  'WINDOW', 'QUALIFY', 'FOR', 'CONNECT', 'START', 'RETURNING', 'OPTION',
]);

const WORD_START = /[A-Za-z_@#$\u0080-￿]/;
const WORD_CHAR = /[\w@#$\u0080-￿]/;

// 주석 제거 · 문자열 리터럴은 내용 없는 'str' 토큰으로 → 리터럴 안의 FROM · JOIN 오탐 방지
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  const readQuoted = (open: number, close: string): string => {
    let j = open + 1;
    let v = '';
    while (j < n) {
      if (sql[j] === close) {
        if (sql[j + 1] === close) {
          v += close;
          j += 2;
          continue;
        }
        break;
      }
      v += sql[j];
      j += 1;
    }
    i = j + 1;
    return v;
  };

  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === "'") {
      readQuoted(i, "'");
      tokens.push({ t: 'str', v: '', u: '' });
    } else if (c === '"' || c === '`') {
      const v = readQuoted(i, c);
      tokens.push({ t: 'qid', v, u: v.toUpperCase() });
    } else if (c === '[') {
      const v = readQuoted(i, ']');
      tokens.push({ t: 'qid', v, u: v.toUpperCase() });
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j])) j += 1;
      const v = sql.slice(i, j);
      tokens.push({ t: 'id', v, u: v.toUpperCase() });
      i = j;
    } else if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(sql[j])) j += 1;
      tokens.push({ t: 'num', v: sql.slice(i, j), u: '' });
      i = j;
    } else {
      tokens.push({ t: 'p', v: c, u: c });
      i += 1;
    }
  }
  return tokens;
}

function isKw(tok: Token | undefined, word: string): boolean {
  return !!tok && tok.t === 'id' && tok.u === word;
}

function isP(tok: Token | undefined, ch: string): boolean {
  return !!tok && tok.t === 'p' && tok.v === ch;
}

function isName(tok: Token | undefined): boolean {
  return !!tok && (tok.t === 'qid' || (tok.t === 'id' && !RESERVED.has(tok.u)));
}

// toks[open] 이 '(' 일 때 짝이 맞는 ')' 인덱스 (없으면 마지막 인덱스)
function matchParen(toks: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i += 1) {
    if (isP(toks[i], '(')) depth += 1;
    else if (isP(toks[i], ')')) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return toks.length - 1;
}

// depth 0 에서 조건을 만족하는 첫 토큰 인덱스
function findTopLevel(toks: Token[], from: number, pred: (tok: Token) => boolean): number {
  for (let i = from; i < toks.length; i += 1) {
    if (isP(toks[i], '(')) {
      i = matchParen(toks, i);
      continue;
    }
    if (pred(toks[i])) return i;
  }
  return -1;
}

function lastSegment(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1];
}

// `a.b.c` 처럼 점으로 이어진 이름 (마지막이 `*` 일 수 있음) 이면 세그먼트 배열, 아니면 null
function dottedName(toks: Token[]): string[] | null {
  if (toks.length === 0 || toks.length % 2 === 0) return null;
  const parts: string[] = [];
  for (let i = 0; i < toks.length; i += 1) {
    const tok = toks[i];
    if (i % 2 === 1) {
      if (!isP(tok, '.')) return null;
    } else if (tok.t === 'id' || tok.t === 'qid') {
      parts.push(tok.v);
    } else if (isP(tok, '*') && i === toks.length - 1) {
      parts.push('*');
    } else {
      return null;
    }
  }
  return parts;
}

function parseItem(toks: Token[]): SelectItem {
  let alias: string | null = null;
  let expr = toks;

  if (toks.length >= 3 && isName(toks[0]) && isP(toks[1], '=')) {
    // MSSQL: SELECT 별칭 = 표현식
    alias = toks[0].v;
    expr = toks.slice(2);
  } else if (toks.length >= 2 && isName(toks[toks.length - 1])) {
    const prev = toks[toks.length - 2];
    if (isKw(prev, 'AS')) {
      alias = toks[toks.length - 1].v;
      expr = toks.slice(0, -2);
    } else if (!isP(prev, '.')) {
      alias = toks[toks.length - 1].v;
      expr = toks.slice(0, -1);
    }
  }

  const parts = dottedName(expr);
  if (parts && parts[parts.length - 1] === '*') {
    const qual = parts.length > 1 ? parts.slice(0, -1).join('.').toLowerCase() : null;
    return { star: true, qual, key: null, col: null };
  }
  if (parts) {
    const col = parts[parts.length - 1];
    const qual = parts.length > 1 ? parts.slice(0, -1).join('.').toLowerCase() : null;
    return { star: false, qual, key: alias ?? col, col };
  }
  return { star: false, qual: null, key: alias, col: null };
}

function parseItems(toks: Token[]): SelectItem[] {
  let i = 0;
  // SELECT 직후 수식어: DISTINCT [ON (...)] · ALL · TOP n [PERCENT] [WITH TIES]
  for (;;) {
    const tok = toks[i];
    if (isKw(tok, 'DISTINCT') || isKw(tok, 'ALL') || isKw(tok, 'DISTINCTROW') || (tok?.t === 'id' && tok.u.startsWith('SQL_'))) {
      i += 1;
      if (isKw(toks[i], 'ON') && isP(toks[i + 1], '(')) i = matchParen(toks, i + 1) + 1;
    } else if (isKw(tok, 'TOP')) {
      i += 1;
      if (isP(toks[i], '(')) i = matchParen(toks, i) + 1;
      else i += 1;
      if (isKw(toks[i], 'PERCENT')) i += 1;
      if (isKw(toks[i], 'WITH') && isKw(toks[i + 1], 'TIES')) i += 2;
    } else {
      break;
    }
  }

  const items: SelectItem[] = [];
  let start = i;
  for (; i <= toks.length; i += 1) {
    if (i < toks.length && isP(toks[i], '(')) {
      i = matchParen(toks, i);
      continue;
    }
    if (i === toks.length || isP(toks[i], ',')) {
      if (i > start) items.push(parseItem(toks.slice(start, i)));
      start = i + 1;
    }
  }
  return items;
}

// toks[i] 부터 테이블 팩터 하나 (테이블 · 서브쿼리 · 테이블 함수 + 별칭) 를 읽고 다음 인덱스 반환
function parseFactor(toks: Token[], i: number, ctes: Map<string, QueryInfo>, sources: SqlSource[]): number {
  while (isKw(toks[i], 'LATERAL') || isKw(toks[i], 'ONLY')) i += 1;

  let source: SqlSource | null = null;
  if (isP(toks[i], '(')) {
    const end = matchParen(toks, i);
    source = { table: null, sub: parseQuery(toks.slice(i + 1, end), ctes), alias: null };
    i = end + 1;
  } else if (toks[i] && (toks[i].t === 'id' || toks[i].t === 'qid')) {
    const parts = [toks[i].v];
    i += 1;
    while (isP(toks[i], '.') && toks[i + 1] && (toks[i + 1].t === 'id' || toks[i + 1].t === 'qid')) {
      parts.push(toks[i + 1].v);
      i += 2;
    }
    if (isP(toks[i], '(')) {
      // 테이블 반환 함수 — 스키마 없음
      i = matchParen(toks, i) + 1;
      source = { table: null, sub: null, alias: null };
    } else {
      const table = parts.join('.');
      const cte = parts.length === 1 ? ctes.get(table.toLowerCase()) : undefined;
      source = cte
        ? { table: null, sub: cte, alias: table.toLowerCase() }
        : { table, sub: null, alias: lastSegment(table).toLowerCase() };
    }
  } else {
    return i;
  }

  if (isKw(toks[i], 'AS')) i += 1;
  if (isName(toks[i])) {
    source.alias = toks[i].v.toLowerCase();
    i += 1;
    // PostgreSQL: AS x(col1, col2)
    if (isP(toks[i], '(')) i = matchParen(toks, i) + 1;
  }
  sources.push(source);
  return i;
}

function parseSources(toks: Token[], fromIdx: number, ctes: Map<string, QueryInfo>): SqlSource[] {
  const sources: SqlSource[] = [];
  let i = parseFactor(toks, fromIdx + 1, ctes, sources);
  while (i < toks.length) {
    const tok = toks[i];
    if (tok.t === 'id' && CLAUSE_END.has(tok.u)) break;
    if (isKw(tok, 'JOIN') || isKw(tok, 'APPLY') || isKw(tok, 'STRAIGHT_JOIN') || isP(tok, ',')) {
      i = parseFactor(toks, i + 1, ctes, sources);
    } else if (isP(tok, '(')) {
      i = matchParen(toks, i) + 1;
    } else {
      i += 1;
    }
  }
  return sources;
}

function parseQuery(toks: Token[], outerCtes: Map<string, QueryInfo>): QueryInfo {
  const ctes = new Map(outerCtes);
  let i = 0;

  if (isKw(toks[0], 'WITH')) {
    i = 1;
    if (isKw(toks[i], 'RECURSIVE')) i += 1;
    while (toks[i] && (toks[i].t === 'id' || toks[i].t === 'qid')) {
      const name = toks[i].v.toLowerCase();
      i += 1;
      if (isP(toks[i], '(')) i = matchParen(toks, i) + 1; // 컬럼 목록
      if (isKw(toks[i], 'AS')) i += 1;
      while (isKw(toks[i], 'NOT') || isKw(toks[i], 'MATERIALIZED')) i += 1;
      if (!isP(toks[i], '(')) break;
      const end = matchParen(toks, i);
      ctes.set(name, parseQuery(toks.slice(i + 1, end), ctes));
      i = end + 1;
      if (!isP(toks[i], ',')) break;
      i += 1;
    }
  }

  const selectIdx = findTopLevel(toks, i, (tok) => isKw(tok, 'SELECT'));
  if (selectIdx === -1) {
    // (SELECT ...) UNION (SELECT ...) 처럼 괄호로 감싼 쿼리
    if (isP(toks[i], '(')) return parseQuery(toks.slice(i + 1, matchParen(toks, i)), ctes);
    return { items: null, sources: [] };
  }

  const fromIdx = findTopLevel(toks, selectIdx + 1, (tok) => isKw(tok, 'FROM'));
  let itemsEnd = fromIdx;
  if (itemsEnd === -1) {
    itemsEnd = findTopLevel(toks, selectIdx + 1, (tok) => tok.t === 'id' && (CLAUSE_END.has(tok.u) || tok.u === 'INTO'));
    if (itemsEnd === -1) itemsEnd = toks.length;
  }

  const items = parseItems(toks.slice(selectIdx + 1, itemsEnd));
  const sources = fromIdx === -1 ? [] : parseSources(toks, fromIdx, ctes);
  return { items, sources };
}

// 쿼리의 기준 테이블 — 첫 소스가 서브쿼리 · CTE 면 그 안으로 따라 들어감
function primaryTable(query: QueryInfo, depth = 0): string | null {
  const first = query.sources[0];
  if (!first || depth > 8) return null;
  if (first.table) return first.table;
  return first.sub ? primaryTable(first.sub, depth + 1) : null;
}

export function analyzeSql(sql: string | undefined | null): SqlAnalysis {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { baseTable: null, baseTableRef: null, hasJoin: false, query: null };
  }
  const toks = tokenize(sql);
  const query = parseQuery(toks, new Map());
  const baseTableRef = primaryTable(query);
  const hasJoin = toks.some((tok) => isKw(tok, 'JOIN') || isKw(tok, 'APPLY'));
  return {
    baseTable: baseTableRef ? lastSegment(baseTableRef) : null,
    baseTableRef,
    hasJoin,
    query,
  };
}
