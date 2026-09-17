# codex-oracle

Codex CLI 구독 계정으로 Oracle Database를 조회하는 자연어 채팅 서버 템플릿입니다.

## 환경변수

`.env.example`을 `.env`로 복사한 뒤 아래 값을 채워주세요.

```bash
CODEX_MODEL=gpt-5.6-luna
CODEX_CLI_PATH=/Applications/ChatGPT.app/Contents/Resources/codex
```

## 실행

```bash
npm install
npm run schema
npm start
```

서버는 `http://localhost:3111`에서 실행됩니다.
