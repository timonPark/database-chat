# claude-mongodb (Windows)

Claude CLI + MongoDB 자연어 조회 서버 — Windows 전용 템플릿.

## 사전 조건

| 항목 | 버전 |
|------|------|
| Node.js | 18 이상 |
| Claude CLI | 최신 (`npm install -g @anthropic-ai/claude-code`) |
| MongoDB | 6.0 이상 (로컬 또는 Docker) |

## 빠른 시작

```bat
install.bat   ← 최초 1회: 의존성 설치 + .env 생성 + 서버 시작
start.bat     ← 이후 실행
```

브라우저에서 `http://localhost:3111` 접속 후 자연어로 DB를 조회합니다.

## 환경 변수 (.env)

```env
PORT=3111
DB_HOST=127.0.0.1
DB_PORT=27017
DB_DATABASE=your-database-name
DB_USER_NAME=root
DB_USER_PASSWORD=your-password
CLAUDE_MODEL=claude-haiku-4-5-20251001
```

## Docker로 MongoDB 실행

```bat
docker compose -f docker/docker-compose.yml up -d
```

## 스크립트

| 파일 | 설명 |
|------|------|
| `install.bat` | 최초 설치 + 서버 시작 |
| `start.bat` | 서버 시작 |
| `schema.bat` | 스키마 인덱스 생성 (`npm run schema`) |
| `erd.bat` | ERD 다이어그램 생성 (`npm run erd`) |

## Windows 특이 사항

- Claude CLI는 `.cmd` shim → `claude.exe` 절대경로로 resolve해 `shell: false` spawn
- 시스템 프롬프트는 커맨드라인 길이 제한(~8191자) 우회를 위해 임시 파일로 전달
- 포트 점유 해제: `netstat -ano` + `taskkill /PID /F`

문제 발생 시 `TROUBLESHOOTING.md` 참조.
