# database-chat

`npx create-database-chat` 로 스캐폴드되는 로컬 LLM × DB 챗 템플릿 모음. 이 glossary 는 템플릿 전역과 생성된 사용자 프로젝트 양쪽에서 공유하는 canonical 용어를 정의합니다.

## Language

**Session**:
사용자의 하나의 **연속된 질의-응답 흐름** 단위. 사이드바에 하나의 항목으로 보이며, 명시적 삭제 전까지 영구 보존됩니다. 하나의 Scaffolded Project 안에 N개의 Session이 존재할 수 있습니다.
_Avoid_: Conversation, Chat, Thread, Dialog

**Attachment**:
Message 에 **자동으로 매달리는 쿼리 결과 스냅샷**. 세션 복원 시 저장 시점 그대로 다시 렌더하기 위한 목적. DB 내부에 JSON 으로 임베드되며 사용자는 "저장"을 의식하지 않습니다.
_Avoid_: Snapshot, Result, Payload

**Export**:
사용자가 **명시적으로 "엑셀로 받기"를 눌러 만든 파일 아티팩트**. 재다운로드 대상이며 디스크(`data/exports/...`) 에 바이너리로 보존됩니다. Attachment 와 달리 사용자 의도로 생성됩니다.
_Avoid_: Download, File, Artifact, Attachment

**Scaffolded Project**:
`npx create-database-chat` 로 생성된 **하나의 디렉토리**. 자체 `data/chat-history.db` 와 `data/exports/` 를 가지며 N개의 Session 을 품습니다. "프로젝트" 라는 단어는 이 뜻으로만 씁니다 — 사용자의 분석 작업 공간은 Session.
_Avoid_: Workspace, App, Instance (사용자 작업 단위로서의 "Project")

**Natural Language Query**:
사용자가 입력창에 쓴 **자연어 질의 문장**. 예: "2026-10 월 cancelled 주문 보여줘". `messages.text` (role=user) 에 저장됩니다. 코드·대화에서 "query" 라고 쓸 때 이 뜻이 아니라면 **Generated Query** 로 명시해야 합니다.
_Avoid_: Prompt, User input, Request (모호함)

**Generated Query**:
LLM 이 Natural Language Query 로부터 생성한 **실행 가능한 DB 쿼리**. SQL 또는 MongoDB aggregate pipeline. `messages.generated_query` 컬럼에 저장되며 LLM 세션 메모리 재주입 시 사용됩니다. 서버가 이걸 받아 실행 → Attachment 생성.
_Avoid_: Query (단독 사용 금지), SQL (MongoDB 포함 못함), DSL
