# Gemini 시스템 프롬프트

Gemini 템플릿의 시스템 프롬프트도 Claude/Codex와 동일한 5블록 구조를 따릅니다. `agy`는 `--system-prompt` 유사 플래그가 없으므로 **Codex 스타일(프롬프트 앞에 인라인)** 을 채택합니다.

## 주입 방식: 인라인

```ts
function buildGeminiPrompt(message: string, requestId: string, limit: number = 20): string {
  return `${buildSystemPrompt(requestId, limit)}

[사용자 질문]
${message}`;
}

const child = spawn('agy', [
  '-p', buildGeminiPrompt(message.trim(), requestId ?? '', limit),
  '--output-format', 'stream-json',
  '--model', GEMINI_MODEL,
  '--dangerously-skip-permissions',
  '--print-timeout', GEMINI_PRINT_TIMEOUT,
], { stdio: ['ignore', 'pipe', 'pipe'] });
```

## 프롬프트 5블록 구조

내부의 `buildSystemPrompt`는 Claude/Codex 문서와 동일합니다. 세부 설명은 [`../claude/system-prompt.md`](../claude/system-prompt.md)를 참고하세요.

```
1. 역할 한 줄 (설명 없이 즉시 실행 지시)
2. [스키마 요약]        — 테이블/컬렉션 목록 + 한 줄 설명
3. [선택 가이드]        — 자연어 키워드 → 스키마 매핑
4. [엔드포인트 사용법]  — /db-query, /db-aggregate curl 예시
5. 규칙                 — 민감 필드 마스킹, LIMIT, 오류 처리 등
```

## `agy` 관점의 유의점

- **툴 권한 이분법.** `agy`는 툴별 화이트리스트가 없고 `--dangerously-skip-permissions` 전부/전무 방식입니다. 이 플래그가 없으면 헤드리스에서 승인 프롬프트 불가로 자동 거부됩니다. 서버 spawn 시 항상 포함하세요.
- **최대 턴 제한 없음.** CLI에 `--max-turns` 유사 인자가 없습니다. 규칙 블록에서 **"결과 나오면 즉시 응답, 불필요한 재시도 금지"** 를 명시적으로 유지하세요.
- **한국어 응답 강제.** 역할 한 줄에 "한국어로 답한다"를 포함해야 모델이 언어 감지를 잘못하는 사례를 줄일 수 있습니다.
- **에이전트 사고 최소화.** Antigravity는 agentic 성향이 강해서 사고 과정을 응답에 섞을 위험이 큽니다. 특히 JSON 출력을 강제해야 하는 스키마 프롬프트 등에서는 **"Return only raw JSON. Do not think out loud. Do not wrap in code fences."** 를 강하게 강조하세요.

## 커스터마이즈 지점

새 `gemini-<db>` 템플릿을 만들 때 바꿔야 할 것:

1. `buildSystemPrompt`의 역할 한 줄과 DB 이름
2. 스키마 요약/가이드 소스 파서 (Mongo는 컬렉션, SQL은 테이블)
3. 엔드포인트 페이로드 스키마 (`collection`+`filter` vs `sql`)
4. DB 방언별 규칙 (Extended JSON, EXPLAIN, `TOP` vs `LIMIT` 등)

주입 방식(인라인)과 `spawn` 인자, SSE 프로토콜은 프로젝트 전역에서 일관되게 유지하세요.

## 스키마 정보 소스

- **인덱스 파일**: `./index.md` — 자연어 키워드 → 이름 매핑 요약.
- **스키마 상세**: `./collections/<name>.md` (Mongo) 또는 `./tables/<name>.md` (SQL).
- **스키마 생성 프롬프트**: `seeds/mongodb/generate-schema-prompt.<provider>.md` — Gemini용은 `.gemini.md` 파일을 `agy -p` 로 검증하며 작성 (#12 참조).
