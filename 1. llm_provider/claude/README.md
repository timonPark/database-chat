# Claude — LLM Provider 레퍼런스

`create-database-chat` 스캐폴딩이 생성하는 Claude 기반 템플릿(`claude-mongodb`, `claude-mysql`, `claude-postgresql`, `claude-oracle`, `claude-mssql`)이 Anthropic Claude를 어떻게 사용하는지 기술한 참조 문서 세트입니다.

새로운 `claude-<db>` 조합 템플릿을 만들거나 기존 템플릿을 수정할 때 이 문서를 참고하세요.

## 핵심 원칙

- **인증은 Claude CLI에 위임한다.** 서버 코드에는 API 키가 들어가지 않습니다. Claude 구독 계정으로 로컬 `claude` CLI에 로그인한 상태를 전제로 하며, 서버는 `child_process.spawn('claude', ...)`로 CLI를 실행합니다.
- **LLM은 직접 DB에 접근하지 않는다.** Claude는 Bash 툴을 통해 `curl`로 서버의 내부 엔드포인트(`/db-query`, `/db-aggregate`)를 호출합니다. DB 자격증명은 서버에만 존재합니다.
- **stream-json 프로토콜로 진행 상황을 스트리밍한다.** `--output-format stream-json --verbose`로 CLI를 실행해 어시스턴트 이벤트를 파싱하고, SSE로 브라우저에 중계합니다.

## 문서 구성

| 파일 | 내용 |
| --- | --- |
| [`spawn.md`](./spawn.md) | Claude CLI 프로세스 실행 인자·이벤트 파싱·취소 처리 |
| [`system-prompt.md`](./system-prompt.md) | 시스템 프롬프트 구조와 DB별 커스터마이즈 지점 |
| [`models.md`](./models.md) | 지원 모델 ID와 선택 기준 |
| [`env.md`](./env.md) | `.env` 변수와 기본값 |

## 참고 링크

- Claude Code CLI: <https://docs.claude.com/en/docs/claude-code>
- 스트리밍 JSON 출력 포맷: `claude --output-format stream-json --verbose`
- 기준 구현: [`templates/claude-mongodb/server.ts`](../../templates/claude-mongodb/server.ts)
