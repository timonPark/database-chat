// LLM 이 뱉은 SELECT 문에서 결과 컬럼 라벨링에 필요한 정보만 추출.
// AST 없이 경량 토크나이저로 defensive 하게 파싱. 해석 못 한 부분은 columns fallback (partial confidence) 에 위임.
//
// 추출 대상:
// - FROM / JOIN 의 실제 테이블 (별칭 포함). CTE 이름은 테이블이 아니므로 제외
// - 최상위 SELECT 목록의 단순 컬럼 참조 (`c.text AS body`, `c.*` 등) — 결과 key 가 어느 테이블에서 왔는지 힌트
// - 식별자 따옴표 (`[x]` · `` `x` `` · `"x"`) 는 벗겨서 비교

export interface TableRef {
  // 따옴표 제거된 원래 이름 (schema.table 이면 그대로 유지 — 스키마 조회 시 양방향 매칭)
  name: string;
  alias: string | null;
  // 0 = 최상위 쿼리, 1 이상 = 서브쿼리 · CTE 본문
  depth: number;
}

export interface SelectItem {
  // 결과 row 의 key 가 될 이름 (별칭 우선)
  outputKey: string;
  // 원본 컬럼명
  column: string;
  // `c.text` 의 `c` (별칭 또는 테이블명). 없으면 null
  qualifier: string | null;
}

export interface SqlAnalysis {
  // 대표 테이블명 (schema 접두사 제외). 엑셀 내보내기 이름 등에 사용
  baseTable: string | null;
  hasJoin: boolean;
  // base 가 맨 앞, 이후 최상위 JOIN 테이블 → 서브쿼리 · CTE 안 테이블 순
  tables: TableRef[];
  selectItems: SelectItem[];
  // `SELECT c.*` 처럼 별칭이 명시된 * 의 qualifier 목록
  starQualifiers: string[];
}

interface Token {
  kind: 'ident' | 'punct' | 'other';
  value: string;
  // 따옴표로 감싼 식별자면 true (키워드로 해석하지 않음)
  quoted: boolean;
  depth: number;
}

const EMPTY: SqlAnalysis = {
  baseTable: null,
  hasJoin: false,
  tables: [],
  selectItems: [],
  starQualifiers: [],
};

// 테이블 뒤에 와도 별칭이 아닌 키워드
const NON_ALIAS_KEYWORDS = new Set<string>([
  'ON', 'USING', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'FOR', 'WINDOW',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'NATURAL', 'STRAIGHT_JOIN', 'APPLY', 'LATERAL',
  'UNION', 'EXCEPT', 'INTERSECT', 'MINUS', 'WITH', 'CONNECT', 'START', 'PIVOT', 'UNPIVOT',
  'TABLESAMPLE', 'SAMPLE', 'PARTITION', 'QUALIFY', 'RETURNING', 'SET', 'VALUES', 'AS', 'SELECT', 'FROM',
  'USE', 'FORCE', 'IGNORE', 'OPTION', 'MODEL', 'MATCH_RECOGNIZE', 'ROWS', 'AND', 'OR', 'NOT',
]);

const SELECT_MODIFIERS = new Set<string>(['DISTINCT', 'ALL', 'UNIQUE', 'SQL_CALC_FOUND_ROWS', 'STRAIGHT_JOIN', 'HIGH_PRIORITY']);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) > 127;
}

function isIdentPart(ch: string): boolean {
  return /[\w$#]/.test(ch) || ch.charCodeAt(0) > 127;
}

// 주석 · 문자열 리터럴은 버리고 식별자 · 구두점만 남긴다. depth 는 괄호 중첩 수준.
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;
  const n = sql.length;

  const readQuoted = (close: string): string => {
    let value = '';
    i += 1;
    while (i < n) {
      if (sql[i] === close) {
        if (sql[i + 1] === close) {
          value += close;
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      value += sql[i];
      i += 1;
    }
    return value;
  };

  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (ch === "'") {
      readQuoted("'");
      tokens.push({ kind: 'other', value: "''", quoted: false, depth });
    } else if (ch === '"' || ch === '`' || ch === '[') {
      const value = readQuoted(ch === '[' ? ']' : ch);
      tokens.push({ kind: 'ident', value, quoted: true, depth });
    } else if (isIdentStart(ch)) {
      let value = '';
      while (i < n && isIdentPart(sql[i])) {
        value += sql[i];
        i += 1;
      }
      tokens.push({ kind: 'ident', value, quoted: false, depth });
    } else if (ch === '(') {
      tokens.push({ kind: 'punct', value: '(', quoted: false, depth });
      depth += 1;
      i += 1;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      tokens.push({ kind: 'punct', value: ')', quoted: false, depth });
      i += 1;
    } else if (ch === ',' || ch === '.' || ch === '*' || ch === ';') {
      tokens.push({ kind: 'punct', value: ch, quoted: false, depth });
      i += 1;
    } else {
      tokens.push({ kind: 'other', value: ch, quoted: false, depth });
      i += 1;
    }
  }
  return tokens;
}

function isKeyword(token: Token | undefined, keyword: string): boolean {
  return !!token && token.kind === 'ident' && !token.quoted && token.value.toUpperCase() === keyword;
}

function isPunct(token: Token | undefined, value: string): boolean {
  return !!token && token.kind === 'punct' && token.value === value;
}

// tokens[openIdx] 가 '(' 일 때 짝이 맞는 ')' 의 다음 인덱스
function skipParens(tokens: Token[], openIdx: number): number {
  const depth = tokens[openIdx].depth;
  for (let j = openIdx + 1; j < tokens.length; j += 1) {
    if (isPunct(tokens[j], ')') && tokens[j].depth === depth) return j + 1;
  }
  return tokens.length;
}

// WITH a AS (...), b (x, y) AS (...) SELECT ... → CTE 이름 수집 + 본 SELECT 시작 인덱스
function readCtes(tokens: Token[]): { names: Set<string>; mainStart: number } {
  const names = new Set<string>();
  if (!isKeyword(tokens[0], 'WITH')) return { names, mainStart: 0 };

  let i = 1;
  if (isKeyword(tokens[i], 'RECURSIVE')) i += 1;
  while (i < tokens.length) {
    const nameTok = tokens[i];
    if (!nameTok || nameTok.kind !== 'ident') break;
    names.add(nameTok.value.toLowerCase());
    i += 1;
    if (isPunct(tokens[i], '(')) i = skipParens(tokens, i); // 컬럼 목록
    if (!isKeyword(tokens[i], 'AS')) break;
    i += 1;
    if (isKeyword(tokens[i], 'NOT')) i += 1;
    if (isKeyword(tokens[i], 'MATERIALIZED')) i += 1;
    if (!isPunct(tokens[i], '(')) break;
    i = skipParens(tokens, i);
    if (isPunct(tokens[i], ',')) {
      i += 1;
      continue;
    }
    break;
  }
  return { names, mainStart: i };
}

// '(' 가 서브쿼리를 여는지 (EXTRACT(YEAR FROM x) 같은 함수 인자의 FROM 을 걸러내기 위함)
function buildSubqueryFlags(tokens: Token[]): boolean[] {
  // flags[i] = tokens[i] 를 감싸는 가장 안쪽 괄호가 없거나(최상위) 서브쿼리 괄호인지
  const flags: boolean[] = new Array(tokens.length).fill(true);
  const stack: boolean[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (isPunct(tok, ')')) stack.pop();
    flags[i] = stack.length === 0 ? true : stack[stack.length - 1];
    if (isPunct(tok, '(')) {
      const next = tokens[i + 1];
      stack.push(isKeyword(next, 'SELECT') || isKeyword(next, 'WITH'));
    }
  }
  return flags;
}

function readAlias(tokens: Token[], i: number): { alias: string | null; next: number } {
  let j = i;
  const hasAs = isKeyword(tokens[j], 'AS');
  if (hasAs) j += 1;
  const tok = tokens[j];
  if (tok && tok.kind === 'ident' && (tok.quoted || !NON_ALIAS_KEYWORDS.has(tok.value.toUpperCase()))) {
    return { alias: tok.value, next: j + 1 };
  }
  return { alias: null, next: i };
}

// FROM / JOIN 뒤 테이블 참조 하나를 읽는다. 서브쿼리 · 함수 호출이면 table 은 null.
function readTableRef(tokens: Token[], i: number): { ref: Omit<TableRef, 'depth'> | null; next: number } {
  const first = tokens[i];
  if (isPunct(first, '(')) {
    const after = skipParens(tokens, i);
    return { ref: null, next: readAlias(tokens, after).next };
  }
  if (!first || first.kind !== 'ident') return { ref: null, next: i };
  if (!first.quoted && (isKeyword(first, 'LATERAL') || isKeyword(first, 'ONLY'))) {
    return readTableRef(tokens, i + 1);
  }

  const parts: string[] = [first.value];
  let j = i + 1;
  while (isPunct(tokens[j], '.') && tokens[j + 1]?.kind === 'ident') {
    parts.push(tokens[j + 1].value);
    j += 2;
  }
  if (isPunct(tokens[j], '(')) {
    // 테이블 반환 함수 (generate_series(...) 등)
    const after = skipParens(tokens, j);
    return { ref: null, next: readAlias(tokens, after).next };
  }
  const { alias, next } = readAlias(tokens, j);
  return { ref: { name: parts.join('.'), alias }, next };
}

function collectTables(tokens: Token[], cteNames: Set<string>, subqueryFlags: boolean[]): TableRef[] {
  const tables: TableRef[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!(isKeyword(tok, 'FROM') || isKeyword(tok, 'JOIN') || isKeyword(tok, 'APPLY'))) continue;
    if (!subqueryFlags[i]) continue;

    let j = i + 1;
    // FROM a x, b y 형태의 콤마 조인까지 읽는다 (JOIN 뒤에는 콤마 목록 없음)
    while (j < tokens.length) {
      const { ref, next } = readTableRef(tokens, j);
      if (ref && !(ref.name.indexOf('.') === -1 && cteNames.has(ref.name.toLowerCase()))) {
        tables.push({ ...ref, depth: tok.depth });
      }
      if (next === j) break;
      j = next;
      if (isKeyword(tok, 'FROM') && isPunct(tokens[j], ',') && tokens[j].depth === tok.depth) {
        j += 1;
        continue;
      }
      break;
    }
  }
  // 최상위 쿼리 테이블 먼저, 같은 깊이는 등장 순서 유지 (sort 는 stable)
  return tables.sort((a, b) => (a.depth === 0 ? 0 : 1) - (b.depth === 0 ? 0 : 1));
}

function parseSelectItem(item: Token[]): SelectItem | 'star' | { star: string } | null {
  if (item.length === 0) return null;

  let exprEnd = item.length;
  let alias: string | null = null;
  const last = item[item.length - 1];
  const prev = item[item.length - 2];
  if (item.length >= 3 && isKeyword(prev, 'AS') && last.kind === 'ident') {
    alias = last.value;
    exprEnd = item.length - 2;
  } else if (item.length >= 2 && last.kind === 'ident' && !isPunct(prev, '.')) {
    alias = last.value;
    exprEnd = item.length - 1;
  }

  const expr = item.slice(0, exprEnd);
  // 단순 참조만 해석: col | q.col | s.q.col | * | q.*
  for (let k = 0; k < expr.length; k += 1) {
    const t = expr[k];
    const expectName = k % 2 === 0;
    if (expectName && !(t.kind === 'ident' || (isPunct(t, '*') && k === expr.length - 1))) return null;
    if (!expectName && !isPunct(t, '.')) return null;
  }
  if (expr.length % 2 === 0) return null;

  const colTok = expr[expr.length - 1];
  const qualifier = expr.length >= 3 ? expr[expr.length - 3].value : null;
  if (isPunct(colTok, '*')) return qualifier ? { star: qualifier } : 'star';
  return { outputKey: alias ?? colTok.value, column: colTok.value, qualifier };
}

function collectSelectItems(tokens: Token[], start: number): { items: SelectItem[]; starQualifiers: string[] } {
  const items: SelectItem[] = [];
  const starQualifiers: string[] = [];

  // 본 쿼리의 첫 SELECT (Oracle ROWNUM 래핑처럼 SELECT * FROM (SELECT ...) 이면 안쪽 목록도 이어서 읽는다)
  let i = start;
  while (i < tokens.length && !isKeyword(tokens[i], 'SELECT')) i += 1;

  while (i < tokens.length && isKeyword(tokens[i], 'SELECT')) {
    const depth = tokens[i].depth;
    let j = i + 1;
    while (j < tokens.length) {
      const t = tokens[j];
      if (t.kind === 'ident' && !t.quoted && SELECT_MODIFIERS.has(t.value.toUpperCase())) {
        j += 1;
      } else if (isKeyword(t, 'TOP')) {
        j += 1;
        if (isPunct(tokens[j], '(')) j = skipParens(tokens, j);
        else j += 1;
        if (isKeyword(tokens[j], 'PERCENT')) j += 1;
        if (isKeyword(tokens[j], 'WITH') && isKeyword(tokens[j + 1], 'TIES')) j += 2;
      } else if (isKeyword(t, 'ON') && isPunct(tokens[j + 1], '(')) {
        j = skipParens(tokens, j + 1); // DISTINCT ON (...)
      } else {
        break;
      }
    }

    let current: Token[] = [];
    let onlyStar = true;
    const flush = () => {
      const parsed = parseSelectItem(current);
      if (parsed !== 'star') onlyStar = false;
      if (parsed && parsed !== 'star') {
        if ('star' in parsed) starQualifiers.push(parsed.star);
        else items.push(parsed);
      }
      current = [];
    };
    for (; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (t.depth < depth || (t.depth === depth && (isKeyword(t, 'FROM') || isPunct(t, ';')))) break;
      if (t.depth === depth && isPunct(t, ',')) {
        flush();
        continue;
      }
      current.push(t);
    }
    flush();

    // SELECT * FROM (SELECT ...) 래핑이면 안쪽 SELECT 목록으로 내려간다
    if (!onlyStar || !isKeyword(tokens[j], 'FROM') || !isPunct(tokens[j + 1], '(') || !isKeyword(tokens[j + 2], 'SELECT')) break;
    i = j + 2;
  }

  return { items, starQualifiers };
}

function lastSegment(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1];
}

export function analyzeSql(sql: string | undefined | null): SqlAnalysis {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { ...EMPTY };
  }

  const tokens = tokenize(sql);
  const { names: cteNames, mainStart } = readCtes(tokens);
  const subqueryFlags = buildSubqueryFlags(tokens);
  const tables = collectTables(tokens, cteNames, subqueryFlags);
  const { items, starQualifiers } = collectSelectItems(tokens, mainStart);
  const hasJoin = tokens.some((t) => isKeyword(t, 'JOIN'));

  return {
    baseTable: tables.length > 0 ? lastSegment(tables[0].name) : null,
    hasJoin,
    tables,
    selectItems: items,
    starQualifiers,
  };
}
