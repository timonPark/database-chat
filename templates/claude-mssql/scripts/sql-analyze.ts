// LLM 이 뱉은 SELECT 문에서 base 테이블명 + JOIN 여부만 추출.
// AST 없이 regex 로 defensive 하게 파싱. JOIN alias 등 복잡한 경우는 columns fallback (partial confidence) 에 위임.

export interface SqlAnalysis {
  baseTable: string | null;
  hasJoin: boolean;
}

// 첫 FROM 절의 테이블명 (schema.table 이면 table 만). 서브쿼리·CTE 안의 FROM 은 무시하고 최상위 FROM 만 잡는다.
// 단순화: 문자열에서 처음 매치되는 FROM 을 기본 테이블로 간주.
const FROM_TABLE_REGEX = /\bFROM\s+(?:(?:[a-zA-Z_][\w]*)\.)?([a-zA-Z_][\w]*)/i;
const JOIN_REGEX = /\bJOIN\b/i;

// 주석·문자열 리터럴을 벗겨내면 오탐이 줄어들지만, MVP 는 원문 그대로 검사.
// 실무 리스크: 문자열 리터럴 안에 "FROM" · "JOIN" 이 들어있으면 오탐 → 이 경우도 서버 실행에는 영향 없음 (컬럼 라벨링만 partial 로 떨어짐).
export function analyzeSql(sql: string | undefined | null): SqlAnalysis {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { baseTable: null, hasJoin: false };
  }
  const fromMatch = sql.match(FROM_TABLE_REGEX);
  const baseTable = fromMatch ? fromMatch[1] : null;
  const hasJoin = JOIN_REGEX.test(sql);
  return { baseTable, hasJoin };
}
