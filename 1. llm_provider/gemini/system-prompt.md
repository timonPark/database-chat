# Gemini 시스템 프롬프트

Gemini 템플릿의 시스템 프롬프트도 Claude/Codex와 동일한 5블록 구조를 따릅니다. 구현 시 결정할 부분은 "시스템 프롬프트를 별도 인자로 주입하는가, 프롬프트 앞에 인라인으로 붙이는가"입니다.

> **상태**: `gemini-<db>` 템플릿 미구현. 첫 구현 시 `gemini --help`로 아래 두 방식 중 어느 것을 쓸지 확정하세요.

## 두 가지 주입 방식

**A) `--system-prompt` 같은 별도 플래그가 있으면 → Claude 방식**

```ts
const child = spawn('gemini', [
  /* 프롬프트 */, message.trim(),
  '--system-prompt', buildSystemPrompt(requestId, limit),
  /* 나머지 인자 */,
]);
```

**B) 별도 플래그가 없으면 → Codex 방식 (인라인)**

```ts
function buildGeminiPrompt(message: string, requestId: string, limit: number = 20): string {
  return `${buildSystemPrompt(requestId, limit)}

[사용자 질문]
${message}`;
}

const child = spawn('gemini', [
  /* 모델 등 */,
  buildGeminiPrompt(message.trim(), requestId ?? '', limit),  // positional
]);
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

## Gemini 관점의 유의점

- **툴 화이트리스트 확인.** Gemini CLI에 `--allowedTools` 유사 인자가 있으면 `Bash`(또는 CLI가 부여하는 셸 도구명)만 허용하세요. 없다면 프롬프트 규칙에 "내부 endpoint로 curl만 사용" 지침을 강조.
- **최대 턴 제한.** CLI에 `--max-turns` 유사 인자가 있으면 10 정도로 설정. 없다면 규칙 블록에서 "결과 나오면 즉시 응답" 지시를 명확히 유지.
- **한국어 응답 강제.** 역할 한 줄에 "한국어로 답한다"를 포함해야 모델이 언어 감지를 잘못하는 사례를 줄일 수 있습니다.

## 커스터마이즈 지점

새 `gemini-<db>` 템플릿을 만들 때 바꿔야 할 것:

1. `buildSystemPrompt`의 역할 한 줄과 DB 이름
2. 스키마 요약/가이드 소스 파서 (Mongo는 컬렉션, SQL은 테이블)
3. 엔드포인트 페이로드 스키마 (`collection`+`filter` vs `sql`)
4. DB 방언별 규칙 (Extended JSON, EXPLAIN, `TOP` vs `LIMIT` 등)

주입 방식(A/B)과 `spawn` 인자, SSE 프로토콜은 프로젝트 전역에서 일관되게 유지하세요.

## 스키마 정보 소스

- **인덱스 파일**: `./index.md` — 자연어 키워드 → 이름 매핑 요약.
- **스키마 상세**: `./collections/<name>.md` (Mongo) 또는 `./tables/<name>.md` (SQL).
- **스키마 생성 프롬프트**: `seeds/mongodb/generate-schema-prompt.<provider>.md`를 참고해 `.gemini.md` 짝을 추가할 수 있습니다.
