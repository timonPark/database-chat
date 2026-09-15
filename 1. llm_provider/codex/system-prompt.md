# Codex 시스템 프롬프트

Codex CLI는 Claude의 `--system-prompt` 같은 별도 플래그가 없습니다. 대신 시스템 규칙을 사용자 메시지 앞에 인라인으로 붙여 하나의 positional 프롬프트로 전달합니다.

## 조립 방식

기준 구현: `templates/codex-mongodb/server.ts:203`

```ts
function buildCodexPrompt(message: string, requestId: string, limit: number = 20): string {
  return `${buildSystemPrompt(requestId, limit)}

[사용자 질문]
${message}`;
}
```

- 앞부분: `buildSystemPrompt`가 만든 5블록 시스템 규칙(Claude 템플릿과 동일 구조).
- 마지막: `[사용자 질문]` 헤더 + 실제 사용자 메시지.

`spawn` 인자 끝에 이 문자열을 positional로 넘깁니다:

```ts
codexArgs.push('--model', CODEX_MODEL);
codexArgs.push(buildCodexPrompt(message.trim(), requestId ?? '', limit));
```

## 프롬프트 5블록 구조

내부의 `buildSystemPrompt`는 Claude 문서와 동일한 구조를 그대로 씁니다. 자세한 설명은 [`../claude/system-prompt.md`](../claude/system-prompt.md)를 참고하고, 여기서는 Codex 관점의 차이만 정리합니다.

```
1. 역할 한 줄 (설명 없이 즉시 실행 지시)
2. [스키마 요약]        — 테이블/컬렉션 목록 + 한 줄 설명
3. [선택 가이드]        — 자연어 키워드 → 스키마 매핑
4. [엔드포인트 사용법]  — /db-query, /db-aggregate curl 예시
5. 규칙                 — 민감 필드 마스킹, LIMIT, 오류 처리 등
```

## Claude 대비 유의점

- **정지 신호는 프롬프트로만 통제.** Claude에는 `--max-turns`가 있지만 Codex CLI에는 동등한 인자가 없습니다. 프롬프트의 규칙 블록에서 "결과가 나오면 즉시 응답, 그렇지 않으면 원인 설명" 지시를 명확히 유지해 무한 탐색을 막습니다.
- **툴 화이트리스트 없음.** Claude는 `--allowedTools Bash`로 툴을 좁힐 수 있으나 Codex는 샌드박스 레벨(`danger-full-access`)만 지정합니다. 의도치 않은 파일 조작을 막으려면 프롬프트에서 "내부 endpoint로 curl만 사용" 지침을 반복 강조하세요.
- **툴 호출 스트리밍이 없음.** 사용자는 툴이 실행되는 중간 로그를 보지 못하므로, 최종 응답 텍스트에 "몇 건 조회했는지" 요약 문구가 반드시 포함되도록 규칙에 명시합니다.

## 커스터마이즈 지점

새 `codex-<db>` 템플릿을 만들 때 바꿔야 할 것:

1. `buildSystemPrompt`의 역할 한 줄과 DB 이름
2. 스키마 요약/가이드 소스 파서 (Mongo는 컬렉션, SQL은 테이블)
3. 엔드포인트 페이로드 스키마 (`collection`+`filter` vs `sql`)
4. DB 방언별 규칙 (Extended JSON, EXPLAIN, `TOP` vs `LIMIT` 등)

`buildCodexPrompt` 래퍼, `spawn` 인자, 파일 기반 응답 수집, SSE 프로토콜은 절대 바꾸지 마세요. 프런트엔드가 그 계약에 의존합니다.

## 스키마 정보 소스

- **인덱스 파일**: `./index.md` — 자연어 키워드 → 이름 매핑 요약.
- **스키마 상세**: `./collections/<name>.md` (Mongo) 또는 `./tables/<name>.md` (SQL).
- **스키마 생성 프롬프트**: `seeds/mongodb/generate-schema-prompt.codex.md` — Codex `exec`로 스키마 문서를 자동 생성할 때 사용하는 프롬프트 (기존 `.claude.md` 버전과 짝).
