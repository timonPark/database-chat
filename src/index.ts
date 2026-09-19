#!/usr/bin/env node
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { cp, mkdir, rename, readFile, writeFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const DOCKER_DIR   = path.join(__dirname, '..', 'docker');
const SEEDS_DIR    = path.join(__dirname, '..', 'seeds');

// ── 선택지 정의 ─────────────────────────────────────────────────────────────

const LLM_PROVIDERS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'claude', label: 'Claude', hint: 'Anthropic — claude-haiku / sonnet' },
  { value: 'gemini', label: 'Gemini', hint: 'Google — coming soon' },
  { value: 'codex', label: 'Codex', hint: 'OpenAI — coming soon' },
];

const DATABASES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'mongodb',    label: 'MongoDB',                hint: 'document' },
  { value: 'mysql',      label: 'MySQL',                  hint: 'coming soon' },
  { value: 'postgresql', label: 'PostgreSQL',             hint: 'coming soon' },
  { value: 'oracle',     label: 'Oracle Database',        hint: 'coming soon' },
  { value: 'mssql',      label: 'Microsoft SQL Server',   hint: 'coming soon' },
];

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn'] as const;
type PackageManager = (typeof PACKAGE_MANAGERS)[number];

// 실제 템플릿이 존재하는 조합
const AVAILABLE_COMBOS = new Set([
  'claude-mongodb',
  'claude-mysql',
  'claude-postgresql',
  'claude-oracle',
  'claude-mssql',
  'codex-mongodb',
  'codex-mysql',
  'codex-postgresql',
  'codex-mssql',
  'codex-oracle',
  'gemini-mongodb',
  'gemini-mysql',
  'gemini-postgresql',
  'gemini-oracle',
  'gemini-mssql',
]);

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function cancel(msg = 'Cancelled'): never {
  p.cancel(msg);
  process.exit(0);
}

function isCancelled(v: unknown): v is symbol {
  return p.isCancel(v);
}

function detectPackageManager(): PackageManager {
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  return 'npm';
}

async function updatePackageName(targetDir: string, name: string): Promise<void> {
  const pkgPath = path.join(targetDir, 'package.json');
  const raw = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  pkg.name = name;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

async function generateDockerCompose(targetDir: string, database: string, projectName: string): Promise<void> {
  const src = path.join(DOCKER_DIR, database, 'docker-compose.yml');
  const raw = await readFile(src, 'utf-8');
  const rendered = raw.replaceAll('{{PROJECT_NAME}}', projectName);
  const destDir = path.join(targetDir, 'docker');
  await mkdir(destDir, { recursive: true });
  await writeFile(path.join(destDir, 'docker-compose.yml'), rendered);
}

async function generateSeedScript(targetDir: string, database: string, projectName: string): Promise<void> {
  const seedDir = path.join(SEEDS_DIR, database);

  // seed.sh 복사 및 플레이스홀더 치환
  const scriptSrc = path.join(seedDir, 'seed.sh');
  const scriptRaw = await readFile(scriptSrc, 'utf-8');
  const scriptsDir = path.join(targetDir, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(
    path.join(scriptsDir, 'seed.sh'),
    scriptRaw.replaceAll('{{PROJECT_NAME}}', projectName),
  );

  // MongoDB 전용: index.md / collection-mapping.md 덮어쓰기
  if (database === 'mongodb') {
    for (const fname of ['index.md', 'collection-mapping.md']) {
      const overrideSrc = path.join(seedDir, fname);
      if (existsSync(overrideSrc)) {
        await writeFile(path.join(targetDir, fname), await readFile(overrideSrc, 'utf-8'));
      }
    }
  }
}

const DB_DOCS_URL: Record<string, string> = {
  mongodb:    'https://www.mongodb.com/ko-kr/docs/',
  mysql:      'https://dev.mysql.com/doc/',
  postgresql: 'https://www.postgresql.org/docs/',
  oracle:     'https://docs.oracle.com/en/database/oracle/index.html',
  mssql:      'https://learn.microsoft.com/ko-kr/sql/?view=sql-server-ver17',
};

const DB_QUERY_TIPS: Record<string, string[]> = {
  mongodb: [
    '$match를 파이프라인 초반에 배치해 스캔 도큐먼트 수를 줄이세요',
    'explain()으로 쿼리 실행 계획(IXSCAN vs COLLSCAN)을 확인하세요',
    '자주 조회하는 필드에 createIndex()로 인덱스를 추가하세요',
    'Covered Query(인덱스만으로 응답)를 활용하면 도큐먼트 패치를 생략할 수 있습니다',
  ],
  mysql: [
    'EXPLAIN으로 실행 계획을 확인하고 type=ALL(풀스캔)을 제거하세요',
    'SELECT *를 피하고 필요한 컬럼만 명시하세요',
    '자주 WHERE/JOIN에 사용되는 컬럼에 인덱스를 추가하세요',
    'Prepared Statement로 SQL Injection 방지 + 쿼리 캐시를 활용하세요',
  ],
  postgresql: [
    'EXPLAIN ANALYZE로 실제 실행 시간과 계획을 함께 확인하세요',
    'pg_stat_statements 확장으로 느린 쿼리를 추적하세요',
    '부분 인덱스(Partial Index)로 인덱스 크기와 유지 비용을 줄이세요',
    'pgBouncer 등 connection pool을 사용해 연결 수를 관리하세요',
  ],
  oracle: [
    'EXPLAIN PLAN FOR로 실행 계획을 확인하세요',
    'Bind Variable을 사용해 하드 파싱(Hard Parse)을 방지하세요',
    'SQL 힌트(/*+ INDEX(...) */)로 옵티마이저 동작을 제어할 수 있습니다',
    'V$SQL 뷰로 고비용 쿼리를 모니터링하세요',
  ],
  mssql: [
    '실행 계획(Execution Plan) 탭 또는 SET SHOWPLAN_ALL ON으로 분석하세요',
    'sp_executesql로 파라미터화 쿼리를 실행해 플랜 캐시를 재사용하세요',
    'Filtered Index로 특정 WHERE 조건에 최적화된 인덱스를 만드세요',
    'sys.dm_exec_query_stats 뷰로 CPU/IO 고비용 쿼리를 찾으세요',
  ],
};

const DB_DRIVER_DEPS: Record<string, Record<string, string>> = {
  mongodb:    { mongodb: '^6.0.0' },
  mysql:      { mysql2: '^3.0.0' },
  postgresql: { pg: '^8.0.0', '@types/pg': '^8.11.0' },
  oracle:     { oracledb: '^6.0.0' },
  mssql:      { mssql: '^11.0.0' },
};

const DB_ENV_EXAMPLE: Record<string, string> = {
  mongodb: [
    'PORT=3111',
    'DB_HOST=127.0.0.1',
    'DB_PORT=27017',
    'DB_DATABASE=',
    'DB_USER_NAME=',
    'DB_USER_PASSWORD=',
    'CLAUDE_MODEL=claude-haiku-4-5-20251001',
    'CLAUDE_MAX_TURNS=10',
  ].join('\n'),
  mysql: [
    'PORT=3111',
    'DB_HOST=127.0.0.1',
    'DB_PORT=3306',
    'DB_DATABASE=sakila',
    'DB_USER_NAME=dbuser',
    'DB_USER_PASSWORD=',
    'CLAUDE_MODEL=claude-haiku-4-5-20251001',
    'CLAUDE_MAX_TURNS=10',
  ].join('\n'),
  postgresql: [
    'PORT=3111',
    'DB_HOST=127.0.0.1',
    'DB_PORT=5432',
    'DB_DATABASE=',
    'DB_USER_NAME=',
    'DB_USER_PASSWORD=',
    'CLAUDE_MODEL=claude-haiku-4-5-20251001',
    'CLAUDE_MAX_TURNS=10',
  ].join('\n'),
  oracle: [
    'PORT=3111',
    'DB_HOST=127.0.0.1',
    'DB_PORT=1521',
    'DB_SERVICE_NAME=',
    'DB_USER_NAME=',
    'DB_USER_PASSWORD=',
    'CLAUDE_MODEL=claude-haiku-4-5-20251001',
    'CLAUDE_MAX_TURNS=10',
  ].join('\n'),
  mssql: [
    'PORT=3111',
    'DB_HOST=127.0.0.1',
    'DB_PORT=1433',
    'DB_DATABASE=',
    'DB_USER_NAME=',
    'DB_USER_PASSWORD=',
    'CLAUDE_MODEL=claude-haiku-4-5-20251001',
    'CLAUDE_MAX_TURNS=10',
  ].join('\n'),
};

async function generateMinimalPackageJson(
  targetDir: string,
  database: string,
  projectName: string,
): Promise<void> {
  const deps = {
    dotenv: '^16.0.0',
    tsx: '^4.0.0',
    ...(DB_DRIVER_DEPS[database] ?? {}),
  };
  const pkg = {
    name: projectName,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      seed:   'bash scripts/seed.sh',
      schema: 'bash scripts/generate-schema.sh',
      erd:    'npx --no-install tsx scripts/generate-erd.ts',
    },
    dependencies: deps,
  };
  await writeFile(path.join(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

async function generateEnvExample(targetDir: string, database: string): Promise<void> {
  const content = DB_ENV_EXAMPLE[database] ?? '';
  await writeFile(path.join(targetDir, '.env.example'), content + '\n');
}

async function addSeedScript(targetDir: string): Promise<void> {
  const pkgPath = path.join(targetDir, 'package.json');
  const raw = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  pkg.scripts = { ...pkg.scripts, seed: 'bash scripts/seed.sh' };
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

async function generateSchemaScript(targetDir: string, database: string, provider: string): Promise<void> {
  const promptSrc    = path.join(SEEDS_DIR, database, `generate-schema-prompt.${provider}.md`);
  const extractSrc   = path.join(SEEDS_DIR, database, 'extract-schema.ts');
  if (!existsSync(promptSrc) || !existsSync(extractSrc)) return;

  const scriptsDir = path.join(targetDir, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  await cp(promptSrc,  path.join(scriptsDir, 'generate-schema-prompt.md'));
  await cp(extractSrc, path.join(scriptsDir, 'extract-schema.ts'));

  const sh = buildGenerateSchemaSh(database, provider);
  await writeFile(path.join(scriptsDir, 'generate-schema.sh'), sh, { mode: 0o755 });
}

interface EntityConfig {
  database: string;
  isMongo: boolean;
  mappingFile: string;      // collection-mapping.md / table-mapping.md
  dbEnvKey: string;         // DB_DATABASE / DB_SERVICE_NAME
  entityTag: string;        // COLLECTION / TABLE
  entityLabel: string;      // 컬렉션 / 테이블
  entityDir: string;        // collections / tables
  entityKey: string;        // JSON key for gemini/codex 응답
  dbDisplayName: string;    // MongoDB / MySQL / PostgreSQL / Oracle / MSSQL
  fieldLabel: string;       // 필드 / 컬럼
  relatedLabel: string;     // 관련 컬렉션 / 관련 테이블
  idFieldExample: string;   // 마크다운 예시 로우
}

function getEntityConfig(database: string): EntityConfig {
  const isMongo = database === 'mongodb';
  const dbDisplayNames: Record<string, string> = {
    mongodb: 'MongoDB', mysql: 'MySQL', postgresql: 'PostgreSQL',
    oracle: 'Oracle', mssql: 'MSSQL',
  };
  return {
    database,
    isMongo,
    mappingFile:   isMongo ? 'collection-mapping.md' : 'table-mapping.md',
    dbEnvKey:      database === 'oracle' ? 'DB_SERVICE_NAME' : 'DB_DATABASE',
    entityTag:     isMongo ? 'COLLECTION' : 'TABLE',
    entityLabel:   isMongo ? '컬렉션' : '테이블',
    entityDir:     isMongo ? 'collections' : 'tables',
    entityKey:     isMongo ? 'collections' : 'tables',
    dbDisplayName: dbDisplayNames[database] ?? database,
    fieldLabel:    isMongo ? '필드' : '컬럼',
    relatedLabel:  isMongo ? '관련 컬렉션' : '관련 테이블',
    // 백틱은 heredoc(비인용) 안에서 command substitution 으로 해석되므로 반드시 \` 로 이스케이프.
    idFieldExample: isMongo
      ? '| \\`_id\\` | ObjectId | 고유 식별자 |'
      : '| \\`id\\`  | int      | 고유 식별자 |',
  };
}

// #87: provider별 default 모델. 모델 목록은 스크립트 실행 시점에 CLI 로 조회하고
// 조회 실패 시 이 default 하나만 후보로 노출한다 (하드코딩 방지).
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  claude: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-3.8-flash-medium',
  codex:  'gpt-5.6-luna',
};

const PROVIDER_MODEL_ENV: Record<string, string> = {
  claude: 'CLAUDE_MODEL',
  gemini: 'GEMINI_MODEL',
  codex:  'CODEX_MODEL',
};

function buildGenerateSchemaSh(database: string, provider: string): string {
  const cfg = getEntityConfig(database);
  const { mappingFile, dbEnvKey, entityTag, entityLabel, entityDir, entityKey,
          dbDisplayName, fieldLabel, relatedLabel, idFieldExample } = cfg;

  const defaultModel = PROVIDER_DEFAULT_MODEL[provider] ?? '';
  const modelEnvKey = PROVIDER_MODEL_ENV[provider] ?? 'MODEL';

  // ── 헤더 ────────────────────────────────────────────────────────────────────
  const header = `#!/usr/bin/env bash
set -euo pipefail

# nvm 자동 활성화 (Node.js 18+ 필요)
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
[ -s "\$NVM_DIR/nvm.sh" ] && source "\$NVM_DIR/nvm.sh"
NODE_MAJOR=\$(node -e "process.stdout.write(process.version.split('.')[0].slice(1))" 2>/dev/null || echo "0")
if [ "\$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "⚠  Node.js 18+ 필요 (현재: \$(node --version 2>/dev/null || echo '없음'))"
  echo "   nvm use v22 를 실행하거나 Node.js 버전을 업그레이드하세요."
  exit 1
fi

TODAY=$(date +%Y-%m-%d)
DB_NAME=$(grep -v '^#' .env | grep ${dbEnvKey} | cut -d= -f2 | tr -d ' \\r')
`;

  // ── provider별 CLI 감지 (스크립트 상단에서 1회 실행) ────────────────────────
  const providerCliDetect = provider === 'claude'
    ? `# Claude CLI 는 PATH 기반. 별도 감지 없음.\n`
    : provider === 'gemini'
    ? `AGY_BIN="\${AGY_CLI_PATH:-}"
if [ -z "\$AGY_BIN" ]; then
  if command -v agy >/dev/null 2>&1; then
    AGY_BIN="agy"
  elif [ -x "/opt/homebrew/bin/agy" ]; then
    AGY_BIN="/opt/homebrew/bin/agy"
  fi
fi
if [ -z "\$AGY_BIN" ]; then
  echo "오류: Antigravity CLI(agy)를 찾을 수 없습니다."
  echo "      brew install --cask antigravity-cli 로 설치하거나 AGY_CLI_PATH를 설정하세요."
  exit 1
fi
GEMINI_PRINT_TIMEOUT_VALUE="\${GEMINI_PRINT_TIMEOUT:-5m}"
`
    : `CODEX_BIN="\${CODEX_CLI_PATH:-}"
if [ -z "\$CODEX_BIN" ]; then
  if command -v codex >/dev/null 2>&1; then
    CODEX_BIN="codex"
  elif [ -x "/Applications/ChatGPT.app/Contents/Resources/codex" ]; then
    CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex"
  fi
fi
if [ -z "\$CODEX_BIN" ]; then
  echo "오류: Codex CLI를 찾을 수 없습니다."
  echo "      npm install -g @openai/codex 로 설치하거나 CODEX_CLI_PATH를 설정하세요."
  exit 1
fi
`;

  // ── #87: AI 모델 선택 — provider CLI 로 런타임 조회 + fallback ─────────────
  // gemini 만 agy models 조회를 시도. claude/codex 는 default + 직접 입력.
  const modelQuery = provider === 'gemini'
    ? `echo "  (agy models 로 지원 모델 조회 중...)"
while IFS= read -r _line; do
  _model=\$(echo "\$_line" | awk '{print \$1}' | tr -d ' \\t\\r')
  case "\$_model" in
    gemini-*) _MODELS+=("\$_model") ;;
  esac
done < <("\$AGY_BIN" models 2>/dev/null || true)`
    : `# ${provider === 'claude' ? 'Claude' : 'Codex'} CLI 는 안정적인 list-models 명령을 제공하지 않아 조회 없이 default + 직접 입력만 노출.`;

  const modelSelection = `
# ── AI 모델 선택 (#87) — 런타임 CLI 조회 + fallback ─────────────────────────
_DEFAULT_MODEL="${defaultModel}"
_MODELS=()

${modelQuery}

# 조회 결과가 없으면 default 하나만 후보로 둔다.
if [ \${#_MODELS[@]} -eq 0 ]; then
  _MODELS+=("\$_DEFAULT_MODEL")
fi

echo "사용할 AI 모델을 선택하세요:"
_idx=0
for _M in "\${_MODELS[@]}"; do
  _idx=\$((_idx + 1))
  _marker=""
  [ "\$_M" = "\$_DEFAULT_MODEL" ] && _marker=" (default)"
  echo "  \$_idx) \$_M\$_marker"
done
_MAX=\$((_idx + 1))
echo "  \$_MAX) 직접 입력"

read -rp "선택 [1-\$_MAX, default=1]: " MODEL_CHOICE
MODEL_CHOICE=\${MODEL_CHOICE:-1}
if ! [[ "\$MODEL_CHOICE" =~ ^[0-9]+\$ ]] || [ "\$MODEL_CHOICE" -lt 1 ] || [ "\$MODEL_CHOICE" -gt "\$_MAX" ]; then
  echo "잘못된 선택: \$MODEL_CHOICE"; exit 1
fi
if [ "\$MODEL_CHOICE" = "\$_MAX" ]; then
  read -rp "모델명: " MODEL_VALUE
  if [ -z "\$MODEL_VALUE" ]; then echo "모델명이 비어있습니다. 종료."; exit 1; fi
else
  MODEL_VALUE="\${_MODELS[\$((MODEL_CHOICE - 1))]}"
fi
export ${modelEnvKey}="\$MODEL_VALUE"
echo "  선택된 모델: \$MODEL_VALUE"
echo ""
`;

  // ── #83: 업데이트 범위 선택 ──────────────────────────────────────────────────
  const modeSelection = `
# ── 업데이트 범위 선택 (#83) ──────────────────────────────────────────────────
echo "업데이트 범위를 선택하세요:"
echo "  1) 전체 업데이트 — 모든 ${entityLabel} 재생성 + index.md/${mappingFile} 갱신"
echo "  2) 부분 업데이트 — ${entityDir}/ 폴더에 아직 .md 없는 ${entityLabel}만"
echo "  3) 부분 업데이트 — 직접 지정한 ${entityLabel}만"
read -rp "선택 [1-3, default=1]: " MODE_CHOICE
MODE_CHOICE=\${MODE_CHOICE:-1}

CUSTOM_NAMES=""
case "\$MODE_CHOICE" in
  1) MODE="full" ;;
  2) MODE="partial-missing" ;;
  3)
    MODE="partial-custom"
    read -rp "${entityLabel}명 입력 (공백 또는 쉼표 구분): " CUSTOM_NAMES
    CUSTOM_NAMES=\$(echo "\$CUSTOM_NAMES" | tr ',' ' ' | tr -s ' ')
    if [ -z "\$(echo "\$CUSTOM_NAMES" | tr -d ' ')" ]; then
      echo "입력이 비어있습니다. 종료."; exit 1
    fi
    ;;
  *) echo "잘못된 선택: \$MODE_CHOICE"; exit 1 ;;
esac
echo "  선택된 모드: \$MODE"
echo ""
`;

  // ── 스키마 추출 + 모드 필터링 + 재생성 대상 삭제 + 10개 배치 분할 ─────────
  const extractAndBatch = `
# ── [1/3] 스키마 추출 ────────────────────────────────────────────────────────
echo "[1/3] DB 스키마 추출 중..."
SCHEMA=\$(npx --no-install tsx scripts/extract-schema.ts)
_EXTRACTED_COUNT=\$(echo "\$SCHEMA" | grep -c "^\\[${entityTag}\\]" || true)
echo "      ${entityLabel} \${_EXTRACTED_COUNT}개 추출 완료"

if [ "\$MODE" != "full" ]; then
  SCHEMA=\$(python3 - "\$SCHEMA" "\$MODE" "\$CUSTOM_NAMES" "${entityDir}" "${entityTag}" <<'PYEOF'
import os, sys
schema, mode, custom, entity_dir, tag = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
custom_set = set(n for n in custom.split() if n)
blocks, current = [], []
tag_prefix = f'[{tag}]'
for line in schema.split('\\n'):
    if line.startswith(tag_prefix):
        if current:
            blocks.append(current)
        current = [line]
    elif current:
        current.append(line)
if current:
    blocks.append(current)

def name_of(block):
    header = block[0]
    after = header.split(']', 1)[1].strip()
    return after.split('|', 1)[0].strip()

kept = []
for b in blocks:
    n = name_of(b)
    if mode == 'partial-missing':
        if not os.path.exists(f'{entity_dir}/{n}.md'):
            kept.append(b)
    elif mode == 'partial-custom':
        if n in custom_set:
            kept.append(b)
print('\\n'.join('\\n'.join(b) for b in kept), end='')
PYEOF
)
  ENTITY_COUNT=\$(echo "\$SCHEMA" | grep -c "^\\[${entityTag}\\]" || true)
  echo "      필터링 후 대상 \${ENTITY_COUNT}개 (\${MODE})"
  if [ "\$ENTITY_COUNT" -eq 0 ]; then
    echo "      대상 ${entityLabel}이 없습니다. 종료."; exit 0
  fi
else
  ENTITY_COUNT=\$_EXTRACTED_COUNT
fi
echo ""

# ── 기존 .md 삭제 (재생성 대상만) ────────────────────────────────────────────
mkdir -p ${entityDir}
_REGEN_COUNT=0
while IFS= read -r _NAME; do
  [ -z "\$_NAME" ] && continue
  if [ -f "${entityDir}/\${_NAME}.md" ]; then
    rm -f "${entityDir}/\${_NAME}.md"
    _REGEN_COUNT=\$((_REGEN_COUNT + 1))
  fi
done < <(echo "\$SCHEMA" | grep "^\\[${entityTag}\\]" | sed 's/^\\[${entityTag}\\] //' | awk -F'|' '{gsub(/ /, "", \$1); print \$1}')
echo "      기존 .md 재생성 대상 \${_REGEN_COUNT}개 삭제"

# ── [2/3] 10개 배치로 분할 ───────────────────────────────────────────────────
BATCH_SIZE=10
BATCH_DIR=\$(mktemp -d /tmp/_schema_batches.XXXXXX)
python3 - "\$SCHEMA" "\$BATCH_DIR" "\$BATCH_SIZE" "${entityTag}" <<'PYEOF'
import os, sys
schema, out_dir, batch_size, tag = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
blocks, current = [], []
tag_prefix = f'[{tag}]'
for line in schema.split('\\n'):
    if line.startswith(tag_prefix):
        if current:
            blocks.append('\\n'.join(current))
        current = [line]
    elif current:
        current.append(line)
if current:
    blocks.append('\\n'.join(current))
for i in range(0, len(blocks), batch_size):
    batch = blocks[i:i+batch_size]
    idx = i // batch_size + 1
    with open(os.path.join(out_dir, f'batch_{idx:03d}.txt'), 'w') as f:
        f.write('\\n'.join(batch))
PYEOF
BATCH_COUNT=\$(ls "\$BATCH_DIR" | wc -l | tr -d ' ')
echo "[2/3] 배치 분할: 전체 \${BATCH_COUNT}개 (배치당 최대 \${BATCH_SIZE}개)"
echo ""
`;

  // ── 공통: 배치별 markdown 형식 안내 문자열 ─────────────────────────────────
  const perEntityMdFormat = `# <${entityLabel}명>

> **database**: \\\`\${DB_NAME}\\\` | **건수**: N건

## ${fieldLabel} 목록

| ${fieldLabel}명 | 타입 | 설명 |
|--------|------|------|
${idFieldExample}
| \\\`<${fieldLabel}명>\\\` | <타입> | 한글 설명 |

## ${relatedLabel}

- 관련 참조 관계 서술`;

  const finalMdFormats = `## index.md 형식
\\\`\\\`\\\`
# DB ${entityLabel} 인덱스
> **database**: \\\`\${DB_NAME}\\\` — N개 ${entityLabel} / M건
> 최종 업데이트: \${TODAY}

## ${entityLabel} 목록

### 카테고리명
| ${entityLabel}명 | 한글 설명 |
|---------|---------|
| \\\`${entityLabel}명\\\` | 설명 (N건) |
\\\`\\\`\\\`

## ${mappingFile} 형식
\\\`\\\`\\\`
# ${entityLabel} 자연어 매핑 정의서

> **database**: \\\`\${DB_NAME}\\\`

## 카테고리명
| ${entityLabel}명 | 자연어 키워드 | 주요 ${fieldLabel} | 설명 |
|---------|-------------|---------|------|
| \\\`${entityLabel}명\\\` | 키워드1, 키워드2 | \\\`col1\\\`, \\\`col2\\\` | 설명 (N건) |
\\\`\\\`\\\``;

  // ── provider별 배치 호출 블록 ───────────────────────────────────────────────
  let batchCall: string;
  if (provider === 'claude') {
    batchCall = `  cat > /tmp/_schema_batch_prompt.txt <<PROMPT_EOF
아래는 ${dbDisplayName} 데이터베이스 \\\`\${DB_NAME}\\\`의 ${entityLabel} 정보 일부입니다:

\\\`\\\`\\\`
\${_BATCH_SCHEMA}
\\\`\\\`\\\`

위 ${entityLabel}들 각각에 대해 \\\`${entityDir}/<이름>.md\\\` 파일을 bash heredoc으로 현재 디렉토리에 작성하세요.
index.md 와 ${mappingFile} 는 생성하지 마세요 (이후 별도 단계에서 처리합니다).

## ${entityDir}/<이름>.md 형식

\\\`\\\`\\\`
${perEntityMdFormat}
\\\`\\\`\\\`

## 작성 지침
- 각 ${fieldLabel}의 한글 설명은 이름과 타입을 참고해 자연스럽게 작성하세요
- 반드시 mkdir -p ${entityDir} 후 각 ${entityLabel}마다 heredoc으로 파일 생성
PROMPT_EOF

  claude -p "\$(cat /tmp/_schema_batch_prompt.txt)" \\
    --allowedTools Bash \\
    --model "\$MODEL_VALUE" > /tmp/_schema_claude.log 2>&1 &
  _CLAUDE_PID=\$!

  _SEEN=""
  while kill -0 "\$_CLAUDE_PID" 2>/dev/null; do
    sleep 0.3
    while IFS= read -r _NAME; do
      [ -z "\$_NAME" ] && continue
      [ -f "${entityDir}/\${_NAME}.md" ] || continue
      case "\$_SEEN" in *"|\$_NAME|"*) continue ;; esac
      _SEEN="\$_SEEN|\$_NAME|"
      _TOTAL_DONE=\$((_TOTAL_DONE + 1))
      printf "      [%d/%s] %s 완료\\n" "\$_TOTAL_DONE" "\$ENTITY_COUNT" "\$_NAME"
    done <<< "\$_BATCH_NAMES"
  done
  wait "\$_CLAUDE_PID" || { echo ""; echo "배치 \${_BATCH_IDX} 오류:"; cat /tmp/_schema_claude.log; exit 1; }`;
  } else if (provider === 'gemini') {
    batchCall = `  cat > /tmp/_schema_batch_prompt.txt <<PROMPT_EOF
아래는 ${dbDisplayName} 데이터베이스 \\\`\${DB_NAME}\\\`의 ${entityLabel} 정보 일부입니다:

\\\`\\\`\\\`
\${_BATCH_SCHEMA}
\\\`\\\`\\\`

위 ${entityLabel}들에 대해 다음 JSON 만 반환하세요 (다른 텍스트 없이):
{
  "${entityKey}": {
    "<${entityLabel}명>": "<${entityLabel}명>.md 파일의 전체 markdown 내용",
    ...
  }
}

각 markdown 은 다음 형식:
${perEntityMdFormat}

index / mapping 등 다른 키는 넣지 마세요. ${entityKey} 만.
PROMPT_EOF

  "\$AGY_BIN" -p "\$(cat /tmp/_schema_batch_prompt.txt)" \\
    --dangerously-skip-permissions \\
    --output-format text \\
    --model "\$MODEL_VALUE" \\
    --print-timeout "\$GEMINI_PRINT_TIMEOUT_VALUE" > /tmp/_schema_gemini.out 2> /tmp/_schema_gemini.log

  python3 - "\$_TOTAL_DONE" "\$ENTITY_COUNT" "${entityDir}" "${entityKey}" "${entityLabel}" <<'PYEOF'
import json, re, sys, os
prev_done, entity_count, entity_dir, entity_key, entity_label = (
    int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
)
try:
    with open('/tmp/_schema_gemini.out') as f:
        text = f.read()
except FileNotFoundError:
    with open('/tmp/_schema_gemini.log') as f:
        text = f.read()
match = re.search(r'\\{[\\s\\S]*\\}', text)
if not match:
    print('오류: JSON 응답 파싱 실패', file=sys.stderr)
    print(text, file=sys.stderr)
    sys.exit(1)
result = json.loads(match.group())
entities = result.get(entity_key, {})
if not isinstance(entities, dict):
    print(f'오류: {entity_key} 응답 형식이 올바르지 않습니다.', file=sys.stderr)
    sys.exit(1)
os.makedirs(entity_dir, exist_ok=True)
new_done = prev_done
for name, content in entities.items():
    if not isinstance(name, str) or not isinstance(content, str):
        print(f'오류: {entity_label} 상세 정보 형식이 올바르지 않습니다.', file=sys.stderr)
        sys.exit(1)
    if not name or '/' in name or chr(92) in name or name in {'.', '..'}:
        print(f'오류: 허용되지 않는 {entity_label}명입니다: {name}', file=sys.stderr)
        sys.exit(1)
    with open(os.path.join(entity_dir, f'{name}.md'), 'w') as f:
        f.write(content)
    new_done += 1
    print(f'      [{new_done}/{entity_count}] {name} 완료', flush=True)
with open('/tmp/_batch_done_count', 'w') as f:
    f.write(str(new_done))
PYEOF
  _TOTAL_DONE=\$(cat /tmp/_batch_done_count)`;
  } else {
    batchCall = `  cat > /tmp/_schema_batch_prompt.txt <<PROMPT_EOF
아래는 ${dbDisplayName} 데이터베이스 \\\`\${DB_NAME}\\\`의 ${entityLabel} 정보 일부입니다:

\\\`\\\`\\\`
\${_BATCH_SCHEMA}
\\\`\\\`\\\`

위 ${entityLabel}들에 대해 다음 JSON 만 반환하세요 (다른 텍스트 없이):
{
  "${entityKey}": {
    "<${entityLabel}명>": "<${entityLabel}명>.md 파일의 전체 markdown 내용",
    ...
  }
}

각 markdown 은 다음 형식:
${perEntityMdFormat}

index / mapping 등 다른 키는 넣지 마세요. ${entityKey} 만.
PROMPT_EOF

  "\$CODEX_BIN" exec \\
    --skip-git-repo-check \\
    --sandbox workspace-write \\
    --output-last-message /tmp/_schema_codex.out \\
    --model "\$MODEL_VALUE" \\
    "\$(cat /tmp/_schema_batch_prompt.txt)" > /tmp/_schema_codex.log 2>&1

  python3 - "\$_TOTAL_DONE" "\$ENTITY_COUNT" "${entityDir}" "${entityKey}" "${entityLabel}" <<'PYEOF'
import json, re, sys, os
prev_done, entity_count, entity_dir, entity_key, entity_label = (
    int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
)
try:
    with open('/tmp/_schema_codex.out') as f:
        text = f.read()
except FileNotFoundError:
    with open('/tmp/_schema_codex.log') as f:
        text = f.read()
match = re.search(r'\\{[\\s\\S]*\\}', text)
if not match:
    print('오류: JSON 응답 파싱 실패', file=sys.stderr)
    print(text, file=sys.stderr)
    sys.exit(1)
result = json.loads(match.group())
entities = result.get(entity_key, {})
if not isinstance(entities, dict):
    print(f'오류: {entity_key} 응답 형식이 올바르지 않습니다.', file=sys.stderr)
    sys.exit(1)
os.makedirs(entity_dir, exist_ok=True)
new_done = prev_done
for name, content in entities.items():
    if not isinstance(name, str) or not isinstance(content, str):
        print(f'오류: {entity_label} 상세 정보 형식이 올바르지 않습니다.', file=sys.stderr)
        sys.exit(1)
    if not name or '/' in name or chr(92) in name or name in {'.', '..'}:
        print(f'오류: 허용되지 않는 {entity_label}명입니다: {name}', file=sys.stderr)
        sys.exit(1)
    with open(os.path.join(entity_dir, f'{name}.md'), 'w') as f:
        f.write(content)
    new_done += 1
    print(f'      [{new_done}/{entity_count}] {name} 완료', flush=True)
with open('/tmp/_batch_done_count', 'w') as f:
    f.write(str(new_done))
PYEOF
  _TOTAL_DONE=\$(cat /tmp/_batch_done_count)`;
  }

  const batchLoop = `
# ── [3/3] 배치별 LLM 호출 ────────────────────────────────────────────────────
echo "[3/3] LLM 호출 시작 (모델: \$MODEL_VALUE)"

_TOTAL_DONE=0
_BATCH_IDX=0
for _BATCH_FILE in "\$BATCH_DIR"/batch_*.txt; do
  _BATCH_IDX=\$((_BATCH_IDX + 1))
  _BATCH_SCHEMA=\$(cat "\$_BATCH_FILE")
  _BATCH_NAMES=\$(echo "\$_BATCH_SCHEMA" | grep "^\\[${entityTag}\\]" | sed 's/^\\[${entityTag}\\] //' | awk -F'|' '{gsub(/ /, "", \$1); print \$1}')
  _BATCH_N=\$(echo "\$_BATCH_NAMES" | grep -c . || true)
  echo "  ── 배치 \${_BATCH_IDX}/\${BATCH_COUNT} (\${_BATCH_N}개 ${entityLabel}) ──"

${batchCall}
done

echo ""

if [ "\$MODE" != "full" ]; then
  echo "  ✔ ${entityDir}/ 부분 갱신 완료 (\${_TOTAL_DONE}개)"
  echo "  ℹ  부분 업데이트 모드 — index.md · ${mappingFile} 는 건드리지 않았습니다."
  rm -rf "\$BATCH_DIR" /tmp/_schema_batch_prompt.txt /tmp/_batch_done_count /tmp/_schema_*.log /tmp/_schema_*.out 2>/dev/null || true
  exit 0
fi
`;

  // ── provider별 최종 aggregation 블록 ────────────────────────────────────────
  let finalCall: string;
  if (provider === 'claude') {
    finalCall = `cat > /tmp/_schema_final_prompt.txt <<FINAL_EOF
아래는 ${dbDisplayName} 데이터베이스 \\\`\${DB_NAME}\\\`의 전체 ${entityLabel} 정보입니다:

\\\`\\\`\\\`
\${SCHEMA}
\\\`\\\`\\\`

${entityDir}/ 디렉토리에는 이미 각 ${entityLabel}별 상세 .md 파일이 생성돼있습니다.
지금은 아래 2개 파일만 bash heredoc으로 현재 디렉토리에 작성하세요.

1. \\\`index.md\\\` — 전체 ${entityLabel} 인덱스
2. \\\`${mappingFile}\\\` — 자연어 키워드 매핑

${finalMdFormats}

## 작성 지침
- ${entityLabel}을 도메인별로 카테고리화하세요
- 한국어 키워드는 자연어 채팅 검색에 적합하게 작성하세요
- 건수 기준 내림차순으로 정렬하세요
FINAL_EOF

claude -p "\$(cat /tmp/_schema_final_prompt.txt)" \\
  --allowedTools Bash \\
  --model "\$MODEL_VALUE" > /tmp/_schema_claude.log 2>&1 || { echo "최종 단계 오류:"; cat /tmp/_schema_claude.log; exit 1; }`;
  } else if (provider === 'gemini') {
    finalCall = `cat > /tmp/_schema_final_prompt.txt <<FINAL_EOF
아래는 ${dbDisplayName} 데이터베이스 \\\`\${DB_NAME}\\\`의 전체 ${entityLabel} 정보입니다:

\\\`\\\`\\\`
\${SCHEMA}
\\\`\\\`\\\`

아래 JSON 만 반환하세요 (다른 텍스트 없이):
{
  "index": "index.md 파일의 전체 markdown 내용",
  "mapping": "${mappingFile} 파일의 전체 markdown 내용"
}

${finalMdFormats}

## 작성 지침
- ${entityLabel}을 도메인별로 카테고리화하세요
- 한국어 키워드는 자연어 채팅 검색에 적합하게 작성하세요
- 건수 기준 내림차순으로 정렬하세요
FINAL_EOF

"\$AGY_BIN" -p "\$(cat /tmp/_schema_final_prompt.txt)" \\
  --dangerously-skip-permissions \\
  --output-format text \\
  --model "\$MODEL_VALUE" \\
  --print-timeout "\$GEMINI_PRINT_TIMEOUT_VALUE" > /tmp/_schema_gemini.out 2> /tmp/_schema_gemini.log

python3 - "${mappingFile}" <<'PYEOF'
import json, re, sys
mapping_file = sys.argv[1]
try:
    with open('/tmp/_schema_gemini.out') as f:
        text = f.read()
except FileNotFoundError:
    with open('/tmp/_schema_gemini.log') as f:
        text = f.read()
match = re.search(r'\\{[\\s\\S]*\\}', text)
if not match:
    print('오류: JSON 응답 파싱 실패', file=sys.stderr); print(text, file=sys.stderr); sys.exit(1)
result = json.loads(match.group())
with open('index.md', 'w') as f: f.write(result.get('index', ''))
with open(mapping_file, 'w') as f: f.write(result.get('mapping', ''))
PYEOF`;
  } else {
    finalCall = `cat > /tmp/_schema_final_prompt.txt <<FINAL_EOF
아래는 ${dbDisplayName} 데이터베이스 \\\`\${DB_NAME}\\\`의 전체 ${entityLabel} 정보입니다:

\\\`\\\`\\\`
\${SCHEMA}
\\\`\\\`\\\`

아래 JSON 만 반환하세요 (다른 텍스트 없이):
{
  "index": "index.md 파일의 전체 markdown 내용",
  "mapping": "${mappingFile} 파일의 전체 markdown 내용"
}

${finalMdFormats}

## 작성 지침
- ${entityLabel}을 도메인별로 카테고리화하세요
- 한국어 키워드는 자연어 채팅 검색에 적합하게 작성하세요
- 건수 기준 내림차순으로 정렬하세요
FINAL_EOF

"\$CODEX_BIN" exec \\
  --skip-git-repo-check \\
  --sandbox workspace-write \\
  --output-last-message /tmp/_schema_codex.out \\
  --model "\$MODEL_VALUE" \\
  "\$(cat /tmp/_schema_final_prompt.txt)" > /tmp/_schema_codex.log 2>&1

python3 - "${mappingFile}" <<'PYEOF'
import json, re, sys
mapping_file = sys.argv[1]
try:
    with open('/tmp/_schema_codex.out') as f:
        text = f.read()
except FileNotFoundError:
    with open('/tmp/_schema_codex.log') as f:
        text = f.read()
match = re.search(r'\\{[\\s\\S]*\\}', text)
if not match:
    print('오류: JSON 응답 파싱 실패', file=sys.stderr); print(text, file=sys.stderr); sys.exit(1)
result = json.loads(match.group())
with open('index.md', 'w') as f: f.write(result.get('index', ''))
with open(mapping_file, 'w') as f: f.write(result.get('mapping', ''))
PYEOF`;
  }

  const finalAggregation = `
# ── 최종 aggregation (전체 모드에서만) ───────────────────────────────────────
echo "  ── 최종 단계: index.md · ${mappingFile} 생성 ──"

${finalCall}

echo ""
[ -f "index.md" ]       && echo "  ✔ index.md 생성 완료"
[ -f "${mappingFile}" ] && echo "  ✔ ${mappingFile} 생성 완료"
[ -d "${entityDir}" ]   && echo "  ✔ ${entityDir}/ 생성 완료 (\${_TOTAL_DONE}개)"

rm -rf "\$BATCH_DIR" /tmp/_schema_batch_prompt.txt /tmp/_schema_final_prompt.txt /tmp/_batch_done_count /tmp/_schema_*.log /tmp/_schema_*.out 2>/dev/null || true
`;

  return header + providerCliDetect + modelSelection + modeSelection + extractAndBatch + batchLoop + finalAggregation;
}

async function addSchemaToPackageScripts(targetDir: string): Promise<void> {
  const pkgPath = path.join(targetDir, 'package.json');
  const raw = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  pkg.scripts = { ...pkg.scripts, schema: 'bash scripts/generate-schema.sh' };
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

async function generateErdScript(targetDir: string, database: string): Promise<void> {
  const erdSrc = path.join(SEEDS_DIR, database, 'generate-erd.ts');
  if (!existsSync(erdSrc)) return;
  const scriptsDir = path.join(targetDir, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  await cp(erdSrc, path.join(scriptsDir, 'generate-erd.ts'));
}

async function addErdToPackageScripts(targetDir: string): Promise<void> {
  const pkgPath = path.join(targetDir, 'package.json');
  const raw = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  pkg.scripts = { ...pkg.scripts, erd: 'npx --no-install tsx scripts/generate-erd.ts' };
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

function buildReadme(
  projectName: string,
  provider: string,
  database: string,
  dbMode: 'existing' | 'docker',
  withSeed: boolean,
  pm: PackageManager | null,
  isSupported: boolean,
): string {
  const dbPort: Record<string, string> = {
    mongodb: '27017', mysql: '3306', postgresql: '5432', oracle: '1521', mssql: '1433',
  };
  const providerLabel: Record<string, string> = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' };
  const dbLabel: Record<string, string> = {
    mongodb: 'MongoDB', mysql: 'MySQL', postgresql: 'PostgreSQL', oracle: 'Oracle', mssql: 'MSSQL',
  };
  const mappingFile = database === 'mongodb' ? 'collection-mapping.md' : 'table-mapping.md';
  const entityDir   = database === 'mongodb' ? 'collections/' : 'tables/';
  const entityType  = database === 'mongodb' ? '컬렉션' : '테이블';
  const port        = dbPort[database] ?? '?';
  const pLabel      = providerLabel[provider] ?? provider;
  const dLabel      = dbLabel[database] ?? database;

  if (!isSupported) {
    const pmCmd = pm ?? 'npm';
    return `# ${projectName}

> **${pLabel} + ${dLabel}** — 서버 템플릿 준비 중 (스키마 생성 사용 가능)

## 생성된 파일

\`\`\`
${projectName}/
├── docker/
│   └── docker-compose.yml
├── scripts/
│   ├── seed.sh
│   ├── extract-schema.ts
│   ├── generate-schema-prompt.md
│   └── generate-schema.sh
├── .env.example
└── package.json
\`\`\`

## 빠른 시작

\`\`\`bash
# 1. DB 기동
docker compose -f docker/docker-compose.yml up -d

# 2. 샘플 데이터 마이그레이션
${pmCmd} run seed

# 3. 환경변수 설정
cp .env.example .env
# .credentials 파일의 비밀번호를 .env의 DB_USER_PASSWORD에 입력

# 4. 스키마 인덱스 자동 생성
${pmCmd} run schema
# → index.md / ${mappingFile} / ${entityDir} 생성
\`\`\`

## 환경변수 (.env)

| 변수명 | 설명 | 기본값 |
|--------|------|--------|
| \`DB_HOST\` | DB 호스트 | \`127.0.0.1\` |
| \`DB_PORT\` | DB 포트 | \`${port}\` |
| \`DB_DATABASE\` | 데이터베이스명 | — |
| \`DB_USER_NAME\` | DB 계정 | — |
| \`DB_USER_PASSWORD\` | DB 비밀번호 | — |
| \`CLAUDE_MODEL\` | Claude 모델 | \`claude-haiku-4-5-20251001\` |
`;
  }

  // 환경변수 테이블
  const envRows: [string, string, string][] = [
    ['PORT',           '서버 포트',         '3111'],
    ['DB_HOST',        'DB 호스트',         'localhost'],
    ['DB_PORT',        'DB 포트',           port],
    ['DB_DATABASE',    '데이터베이스명',     '—'],
    ...(database === 'oracle' ? [['DB_SERVICE_NAME', 'Oracle 서비스명', '—'] as [string, string, string]] : []),
    ['DB_USER_NAME',   'DB 계정',           '—'],
    ['DB_USER_PASSWORD', 'DB 비밀번호',     '—'],
    ...(provider === 'claude' ? [
      ['CLAUDE_MODEL',     'Claude 모델',    'claude-haiku-4-5-20251001'],
      ['CLAUDE_MAX_TURNS', '최대 턴 수',     '10'],
    ] as [string, string, string][] : []),
    ...(provider === 'gemini' ? [['GEMINI_API_KEY', 'Gemini API 키', '—']] as [string, string, string][] : []),
    ...(provider === 'codex' ? [
      ['CODEX_MODEL', 'Codex 모델', 'gpt-5.6-luna'],
      ['CODEX_CLI_PATH', 'Codex CLI 경로', '/Applications/ChatGPT.app/Contents/Resources/codex'],
    ] as [string, string, string][] : []),
  ];
  const envTable = envRows.map(([k, d, v]) => `| \`${k}\` | ${d} | \`${v}\` |`).join('\n');

  const runSteps = [
    'cp .env.example .env',
    '# .env에 DB 접속 정보 입력',
    ...(dbMode === 'docker' ? ['', 'docker compose -f docker/docker-compose.yml up -d'] : []),
    ...(withSeed ? ['', `${pm} run seed`] : []),
    '',
    `${pm} run schema   # index.md / ${mappingFile} 자동 생성`,
    `${pm} start        # → http://localhost:3111`,
  ].join('\n');

  return `# ${projectName}

> **${pLabel} + ${dLabel}** 자연어 데이터베이스 채팅 앱

## 빠른 시작

\`\`\`bash
${runSteps}
\`\`\`

## 환경변수 (.env)

| 변수명 | 설명 | 기본값 |
|--------|------|--------|
${envTable}

## 스키마 인덱스

\`${pm} run schema\` 로 DB ${entityType} 목록·건수·필드를 추출하고 LLM이 아래 파일을 자동 생성합니다.

\`\`\`
index.md                  # ${entityType} 인덱스 (목록 + 파일 트리)
${mappingFile.padEnd(25)} # 자연어 키워드 매핑
${entityDir.padEnd(25)}   # ${entityType}별 컬럼 상세 명세
\`\`\`

## API 엔드포인트

| 엔드포인트 | 설명 |
|-----------|------|
| \`POST /chat\` | LLM 스트리밍 응답 (SSE) |
| \`POST /chat/cancel\` | LLM 프로세스 중단 |
| \`POST /db-query\` | 단순 조회 |
| \`POST /db-aggregate\` | 집계·조인 쿼리 |
| \`POST /db-export\` | 엑셀 내보내기 |
| \`GET /meta\` | 인덱스 최종 업데이트 시각 |
| \`GET /meta/table-info\` | ${entityType} 목록 마크다운 (UI 모달용) |

## 프로젝트 구조

\`\`\`
${projectName}/
├── server.ts
├── public/
│   └── index.html
├── scripts/
│   ├── extract-schema.ts
│   ├── generate-schema-prompt.md
│   └── generate-schema.sh
├── ${entityDir}
├── index.md
├── ${mappingFile}
├── .env.example
└── package.json
\`\`\`
`;
}

async function generateReadme(
  targetDir: string,
  projectName: string,
  provider: string,
  database: string,
  dbMode: 'existing' | 'docker',
  withSeed: boolean,
  pm: PackageManager | null,
  isSupported: boolean,
): Promise<void> {
  const content = buildReadme(projectName, provider, database, dbMode, withSeed, pm, isSupported);
  await writeFile(path.join(targetDir, 'README.md'), content);
}

function buildInstallSh(
  projectName: string,
  provider: string,
  database: string,
  dbMode: 'existing' | 'docker',
): string {
  const dbPort: Record<string, string> = {
    mongodb: '27017', mysql: '3306', postgresql: '5432', oracle: '1521', mssql: '1433',
  };
  const providerLabel: Record<string, string> = { claude: 'Claude (Anthropic)', gemini: 'Gemini (Google)', codex: 'Codex (OpenAI)' };
  const dbLabel: Record<string, string> = {
    mongodb: 'MongoDB', mysql: 'MySQL', postgresql: 'PostgreSQL', oracle: 'Oracle Database', mssql: 'Microsoft SQL Server',
  };
  const dbEnvKey = database === 'oracle' ? 'DB_SERVICE_NAME' : 'DB_DATABASE';
  const docsUrl  = DB_DOCS_URL[database] ?? '';
  const tips     = (DB_QUERY_TIPS[database] ?? []).map(t => `#   - ${t}`).join('\n');
  const port     = dbPort[database] ?? '?';

  // LLM provider 확인 블록
  const providerCheck = provider === 'claude'
    ? `echo ""
echo "  [2/5] Claude CLI 확인..."
if ! command -v claude &>/dev/null; then
  echo -e "\${YELLOW}[!] Claude CLI가 설치되어 있지 않습니다.\${NC}"
  echo "      npm install -g @anthropic-ai/claude-code 로 설치하거나"
  echo "      https://docs.anthropic.com/claude-code 를 참고하세요."
else
  CLAUDE_VER=$(claude --version 2>/dev/null | head -1 || echo "확인 불가")
  echo -e "\${GREEN}[✔] Claude CLI \${CLAUDE_VER}\${NC}"
fi`
    : provider === 'gemini'
    ? `echo ""
echo "  [2/5] GEMINI_API_KEY 확인..."
ENV_KEY=$(grep -v '^#' .env 2>/dev/null | grep 'GEMINI_API_KEY' | cut -d= -f2 | tr -d ' \\r')
if [ -z "\${GEMINI_API_KEY:-}" ] && [ -z "\${ENV_KEY:-}" ]; then
  echo -e "\${YELLOW}[!] GEMINI_API_KEY가 설정되어 있지 않습니다.\${NC}"
  echo "      .env 파일에 GEMINI_API_KEY=<키값> 을 추가하세요."
  echo "      API 키 발급: https://aistudio.google.com/app/apikey"
else
  echo -e "\${GREEN}[✔] GEMINI_API_KEY 확인\${NC}"
fi`
    : `echo ""
echo "  [2/5] Codex CLI 확인..."
if ! command -v codex &>/dev/null; then
  echo -e "\${YELLOW}[!] Codex CLI가 설치되어 있지 않습니다.\${NC}"
  echo "      npm install -g @openai/codex 로 설치하거나"
  echo "      codex login 으로 구독 계정 로그인을 완료하세요."
else
  CODEX_VER=$(codex --version 2>/dev/null | head -1 || echo "확인 불가")
  echo -e "\${GREEN}[✔] Codex CLI \${CODEX_VER}\${NC}"
fi`;

  // .env에 추가할 provider 환경변수 안내
  const providerEnvHint = provider === 'claude'
    ? ''
    : provider === 'gemini'
    ? '  GEMINI_API_KEY=<Gemini API 키>'
    : '  CODEX_MODEL=gpt-5.6-luna';

  // DB 환경변수 안내
  const dbEnvHint = database === 'oracle'
    ? `  DB_SERVICE_NAME=<Oracle 서비스명>`
    : `  DB_DATABASE=<데이터베이스명>`;

  // Docker 블록
  const dockerBlock = dbMode === 'docker'
    ? `echo ""
echo "  [4/5] Docker 컨테이너 확인..."
if ! command -v docker &>/dev/null; then
  echo -e "\${YELLOW}[!] Docker가 설치되어 있지 않습니다.\${NC}"
  echo "      https://docs.docker.com/get-docker/ 에서 설치하세요."
else
  if docker compose -f docker/docker-compose.yml ps --quiet 2>/dev/null | grep -q .; then
    echo -e "\${GREEN}[✔] Docker 컨테이너 실행 중\${NC}"
  else
    echo "      Docker 컨테이너를 시작합니다..."
    docker compose -f docker/docker-compose.yml up -d
    echo -e "\${GREEN}[✔] Docker 컨테이너 시작 완료\${NC}"
  fi
fi`
    : `echo ""
echo "  [4/5] DB 접속 정보를 .env 파일에서 확인하세요 (HOST: \${DB_HOST:-?} PORT: ${port})"`;

  return `#!/usr/bin/env bash
# ================================================================
#  ${projectName} — Install & Start Script (macOS / Linux)
#  LLM Provider : ${providerLabel[provider] ?? provider}
#  Database     : ${dbLabel[database] ?? database}  (port: ${port})
#  DB Docs      : ${docsUrl}
# ================================================================
#
# [DB 조회 최적화 팁] — 자세한 내용: ${docsUrl}
${tips}
#
# ================================================================

set -euo pipefail
GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; RED='\\033[0;31m'; BOLD='\\033[1m'; NC='\\033[0m'

echo ""
echo -e "\${BOLD}================================================================\${NC}"
echo -e "\${BOLD}  ${projectName} 설치 스크립트\${NC}"
echo -e "  LLM Provider : ${providerLabel[provider] ?? provider}"
echo -e "  Database     : ${dbLabel[database] ?? database}  (port: ${port})"
echo -e "  DB Docs      : ${docsUrl}"
echo -e "\${BOLD}================================================================\${NC}"
echo ""

# ── 1/5. Node.js 확인 ──────────────────────────────────────────
echo "  [1/5] Node.js 확인..."
if ! command -v node &>/dev/null; then
  echo -e "\${RED}[오류] Node.js가 설치되어 있지 않습니다.\${NC}"
  echo "      https://nodejs.org 에서 Node.js 18 이상을 설치하세요."
  exit 1
fi
NODE_MAJOR=$(node -e "console.log(parseInt(process.versions.node))")
if [ "\$NODE_MAJOR" -lt 18 ]; then
  echo -e "\${YELLOW}[!] Node.js 18 이상을 권장합니다. 현재: $(node --version)\${NC}"
else
  echo -e "\${GREEN}[✔] Node.js $(node --version)\${NC}"
fi

# ── 2/5. LLM Provider 확인 ─────────────────────────────────────
${providerCheck}

# ── 3/5. 의존성 설치 ───────────────────────────────────────────
echo ""
echo "  [3/5] 의존성 설치 중 (npm install)..."
npm install
echo -e "\${GREEN}[✔] 의존성 설치 완료\${NC}"

# ── 4/5. Docker / DB 확인 ──────────────────────────────────────
${dockerBlock}

# ── 5/5. 환경변수 설정 ─────────────────────────────────────────
echo ""
echo "  [5/5] 환경변수 설정..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "\${YELLOW}[!] .env 파일이 생성됐습니다. 아래 항목을 입력하세요:\${NC}"
  echo ""
  echo "      DB_HOST=127.0.0.1"
  echo "      DB_PORT=${port}"
  echo "      ${dbEnvHint}"
  echo "      DB_USER_NAME=<DB 계정>"
  echo "      DB_USER_PASSWORD=<DB 비밀번호>"
${providerEnvHint ? `  echo "      ${providerEnvHint}"` : ''}
  echo ""
  echo -e "  .env 파일 편집 후 Enter를 누르면 서버가 시작됩니다."
  read -r
else
  echo -e "\${GREEN}[✔] .env 파일 확인\${NC}"
fi

# ── 서버 시작 ──────────────────────────────────────────────────
echo ""
echo -e "\${BOLD}================================================================\${NC}"
if [ -f "server.ts" ]; then
  echo -e "\${GREEN}  서버 시작: http://localhost:\${PORT:-3111}\${NC}"
  echo -e "\${BOLD}================================================================\${NC}"
  echo ""
  npm start
else
  echo -e "\${YELLOW}  server.ts가 없습니다 — 환경 설정 완료 (서버 템플릿 준비 중)\${NC}"
  echo -e "\${BOLD}================================================================\${NC}"
fi
`;
}

function buildInstallBat(
  projectName: string,
  provider: string,
  database: string,
  dbMode: 'existing' | 'docker',
): string {
  const dbPort: Record<string, string> = {
    mongodb: '27017', mysql: '3306', postgresql: '5432', oracle: '1521', mssql: '1433',
  };
  const providerLabel: Record<string, string> = { claude: 'Claude (Anthropic)', gemini: 'Gemini (Google)', codex: 'Codex (OpenAI)' };
  const dbLabel: Record<string, string> = {
    mongodb: 'MongoDB', mysql: 'MySQL', postgresql: 'PostgreSQL', oracle: 'Oracle Database', mssql: 'Microsoft SQL Server',
  };
  const dbEnvKey = database === 'oracle' ? 'DB_SERVICE_NAME' : 'DB_DATABASE';
  const docsUrl  = DB_DOCS_URL[database] ?? '';
  const tips     = (DB_QUERY_TIPS[database] ?? []).map(t => `::   - ${t}`).join('\r\n');
  const port     = dbPort[database] ?? '?';

  const providerCheck = provider === 'claude'
    ? `echo   [2/5] Claude CLI 확인...
where claude >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo [!] Claude CLI 가 설치되어 있지 않습니다.
  echo     npm install -g @anthropic-ai/claude-code 로 설치하거나
  echo     https://docs.anthropic.com/claude-code 를 참고하세요.
) else (
  for /f "tokens=*" %%v in ('claude --version 2^>nul') do echo [v] Claude CLI %%v
)`
    : provider === 'gemini'
    ? `echo   [2/5] GEMINI_API_KEY 확인...
findstr /i "GEMINI_API_KEY=" .env >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo [!] GEMINI_API_KEY 가 .env 에 설정되어 있지 않습니다.
  echo     .env 파일에 GEMINI_API_KEY=^<키값^> 을 추가하세요.
  echo     API 키 발급: https://aistudio.google.com/app/apikey
) else (
  echo [v] GEMINI_API_KEY 확인
)`
    : `echo   [2/5] Codex CLI 확인...
where codex >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo [!] Codex CLI 가 설치되어 있지 않습니다.
  echo     npm install -g @openai/codex 로 설치하거나
  echo     codex login 으로 구독 계정 로그인을 완료하세요.
) else (
  for /f "tokens=*" %%v in ('codex --version 2^>nul') do echo [v] Codex CLI %%v
)`;

  const providerEnvHint = provider === 'claude'
    ? ''
    : provider === 'gemini'
    ? `  echo   GEMINI_API_KEY=^<Gemini API 키^>`
    : `  echo   CODEX_MODEL=gpt-5.6-luna`;

  const dbEnvHint = database === 'oracle'
    ? `  echo   DB_SERVICE_NAME=^<Oracle 서비스명^>`
    : `  echo   DB_DATABASE=^<데이터베이스명^>`;

  const dockerBlock = dbMode === 'docker'
    ? `echo   [4/5] Docker 컨테이너 확인...
where docker >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo [!] Docker 가 설치되어 있지 않습니다.
  echo     https://docs.docker.com/get-docker/ 에서 설치하세요.
) else (
  docker compose -f docker\\docker-compose.yml ps -q 2>nul | findstr /r "." >nul 2>&1
  if %ERRORLEVEL% neq 0 (
    echo     Docker 컨테이너를 시작합니다...
    docker compose -f docker\\docker-compose.yml up -d
    echo [v] Docker 컨테이너 시작 완료
  ) else (
    echo [v] Docker 컨테이너 실행 중
  )
)`
    : `echo   [4/5] DB 접속 정보를 .env 파일에서 확인하세요 (PORT: ${port})`;

  return `@echo off
chcp 65001 >nul 2>&1
:: ================================================================
::  ${projectName} — Install ^& Start Script (Windows)
::  LLM Provider : ${providerLabel[provider] ?? provider}
::  Database     : ${dbLabel[database] ?? database}  (port: ${port})
::  DB Docs      : ${docsUrl}
:: ================================================================
::
:: [DB 조회 최적화 팁] — 자세한 내용: ${docsUrl}
${tips}
::
:: ================================================================

echo.
echo ================================================================
echo   ${projectName} 설치 스크립트  ^(Windows^)
echo   LLM Provider : ${providerLabel[provider] ?? provider}
echo   Database     : ${dbLabel[database] ?? database}  ^(port: ${port}^)
echo   DB Docs      : ${docsUrl}
echo ================================================================
echo.

:: ── 1/5. Node.js 확인 ──────────────────────────────────────────
echo   [1/5] Node.js 확인...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo [오류] Node.js 가 설치되어 있지 않습니다.
  echo   https://nodejs.org 에서 Node.js 18 이상을 설치하세요.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [v] Node.js %%v

:: ── 2/5. LLM Provider 확인 ─────────────────────────────────────
echo.
${providerCheck}

:: ── 3/5. 의존성 설치 ───────────────────────────────────────────
echo.
echo   [3/5] 의존성 설치 중 ^(npm install^)...
call npm install
if %ERRORLEVEL% neq 0 (
  echo [오류] npm install 실패
  pause
  exit /b 1
)
echo [v] 의존성 설치 완료

:: ── 4/5. Docker / DB 확인 ──────────────────────────────────────
echo.
${dockerBlock}

:: ── 5/5. 환경변수 설정 ─────────────────────────────────────────
echo.
echo   [5/5] 환경변수 설정...
if not exist .env (
  copy .env.example .env >nul
  echo [!] .env 파일이 생성됐습니다. 아래 항목을 입력하세요:
  echo.
  echo   DB_HOST=127.0.0.1
  echo   DB_PORT=${port}
${dbEnvHint}
  echo   DB_USER_NAME=^<DB 계정^>
  echo   DB_USER_PASSWORD=^<DB 비밀번호^>
${providerEnvHint}
  echo.
  echo .env 파일 편집 후 아무 키나 누르면 서버가 시작됩니다.
  pause
) else (
  echo [v] .env 파일 확인
)

:: ── 서버 시작 ──────────────────────────────────────────────────
echo.
echo ================================================================
if exist server.ts (
  echo   서버 시작: http://localhost:3111
  echo ================================================================
  echo.
  call npm start
) else (
  echo   server.ts 없음 — 환경 설정 완료 ^(서버 템플릿 준비 중^)
  echo ================================================================
)
pause
`;
}

async function generateInstallScripts(
  targetDir: string,
  projectName: string,
  provider: string,
  database: string,
  dbMode: 'existing' | 'docker',
): Promise<void> {
  const sh  = buildInstallSh(projectName, provider, database, dbMode);
  const bat = buildInstallBat(projectName, provider, database, dbMode);
  await writeFile(path.join(targetDir, 'install.sh'),  sh,  { mode: 0o755 });
  await writeFile(path.join(targetDir, 'install.bat'), bat);
}

function buildStartSh(projectName: string): string {
  return `#!/usr/bin/env bash
# ${projectName} — 서버 시작
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "[!] node_modules 가 없습니다. install.sh 를 먼저 실행하세요."
  exit 1
fi
if [ ! -f .env ]; then
  echo "[!] .env 파일이 없습니다. install.sh 를 먼저 실행하세요."
  exit 1
fi

npm start
`;
}

function buildStartBat(projectName: string): string {
  return `@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
:: ${projectName} — 서버 시작

if not exist node_modules (
  echo [!] node_modules 가 없습니다. install.bat 를 먼저 실행하세요.
  pause
  exit /b 1
)
if not exist .env (
  echo [!] .env 파일이 없습니다. install.bat 를 먼저 실행하세요.
  pause
  exit /b 1
)

call npm start
pause
`;
}

async function generateStartScripts(targetDir: string, projectName: string): Promise<void> {
  await writeFile(path.join(targetDir, 'start.sh'),  buildStartSh(projectName),  { mode: 0o755 });
  await writeFile(path.join(targetDir, 'start.bat'), buildStartBat(projectName));
}

function buildDockerSeedPrompt(withSeed: boolean, pm: PackageManager = 'npm'): string {
  const seedLine = withSeed ? '\n  bash scripts/seed.sh   # 샘플 데이터 마이그레이션' : '';
  return `현재 디렉토리에서 아래 단계를 순서대로 Bash 명령으로 실행하세요.

단계:
  docker compose -f docker/docker-compose.yml up -d${seedLine}
  cp .env.example .env
  ${pm} run schema
  ${pm} run erd   # 실패해도 무시하고 계속 진행

세부 지침:
1. docker compose up 실행 후 DB 포트가 열릴 때까지 최대 30초 대기하세요.
2. seed 완료 후 생성된 .credentials 파일에서 DB 접속 정보를 읽어 .env의 해당 항목에 채워주세요.
3. .env 설정 완료 후 \`${pm} run schema\` 를 실행하면 index.md / table-mapping.md(collection-mapping.md) / tables/(collections/) 가 생성됩니다.
4. \`${pm} run erd\` 는 erd.mmd 를 생성합니다. 실패 시 warning 만 출력하고 다음 단계 계속 진행하세요.
5. 오류가 발생하면 원인을 파악해 해결한 후 계속 진행하세요.`;
}

function buildAutoSetupPrompt(
  steps: string[],
  pm: PackageManager,
  dbMode: 'existing' | 'docker',
  database: string,
): string {
  const mappingFile = database === 'mongodb' ? 'collection-mapping.md' : 'table-mapping.md';
  const stepsBlock  = steps.map(s => `  ${s}`).join('\n');
  const envHint     = dbMode === 'docker'
    ? 'docker/docker-compose.yml 파일에서 DB 접속 정보(호스트, 포트, 유저, 비밀번호, DB명)를 읽어 .env에 채워주세요.'
    : '.env 파일을 직접 편집해 실제 DB 접속 정보를 채워주세요.';

  return `현재 디렉토리에서 아래 단계를 순서대로 Bash 명령으로 실행하세요.

단계:
${stepsBlock}

세부 지침:
1. \`cp .env.example .env\` 실행 후 → ${envHint}
2. Docker 컨테이너가 완전히 기동될 때까지 최대 30초 대기 후 seed를 실행하세요.
3. \`${pm} run schema\` 는 DB가 준비된 상태에서 실행하세요. ${mappingFile} 과 index.md 가 생성됩니다.
4. 오류가 발생하면 원인을 파악해 해결한 후 계속 진행하세요.
5. 마지막으로 \`${pm} start\` 가 정상 기동되면 작업이 완료됩니다.`;
}

async function runAutoSetup(
  targetDir: string,
  provider: string,
  pm: PackageManager,
  dbMode: 'existing' | 'docker',
  database: string,
  withSeed: boolean,
): Promise<void> {
  const spinner = p.spinner();

  type Step = { label: string; fn: () => void; stream?: boolean; nonFatal?: boolean };
  const steps: Step[] = [];

  if (dbMode === 'docker') {
    steps.push({
      label: 'Docker 컨테이너 기동',
      fn: () => {
        const result = spawnSync('docker', ['compose', '-f', 'docker/docker-compose.yml', 'up', '-d'],
          { cwd: targetDir, stdio: 'inherit' });
        if (result.status !== 0) {
          throw new Error('Docker 컨테이너 기동 실패');
        }
      },
      stream: true,
    });
  }

  if (provider === 'claude' || provider === 'codex') {
    steps.push({
      label: `${provider === 'claude' ? 'Claude' : 'Codex'} CLI 확인`,
      fn: () => {
        const command = provider === 'claude'
          ? 'claude'
          : process.env.CODEX_CLI_PATH
            ?? (existsSync('/Applications/ChatGPT.app/Contents/Resources/codex')
              ? '/Applications/ChatGPT.app/Contents/Resources/codex'
              : 'codex');
        const result = spawnSync(command, ['--version'], { cwd: targetDir, stdio: 'inherit' });
        if (result.status !== 0) {
          throw new Error(`${provider === 'claude' ? 'Claude' : 'Codex'} CLI를 찾을 수 없습니다.`);
        }
      },
      stream: true,
    });
  }

  steps.push({
    label: '.env 파일 생성',
    fn: () => {
      const envPath = path.join(targetDir, '.env');
      if (!existsSync(envPath)) {
        execSync('cp .env.example .env', { cwd: targetDir, stdio: 'ignore' });
      }
      // docker-compose.yml에서 실제 DB 접속 정보를 읽어 .env에 반영
      if (dbMode === 'docker') {
        const composePath = path.join(targetDir, 'docker', 'docker-compose.yml');
        if (existsSync(composePath)) {
          const compose = readFileSync(composePath, 'utf-8');
          let env = readFileSync(envPath, 'utf-8');

          const patterns: Array<[RegExp, RegExp, string]> = [
            // [compose 패턴, .env 패턴, .env 키]
            [/MONGO_INITDB_ROOT_USERNAME:\s*(\S+)/, /^DB_USER_NAME=.*/m, 'DB_USER_NAME'],
            [/MONGO_INITDB_ROOT_PASSWORD:\s*(\S+)/, /^DB_USER_PASSWORD=.*/m, 'DB_USER_PASSWORD'],
            [/MONGO_INITDB_DATABASE:\s*(\S+)/, /^DB_DATABASE=.*/m, 'DB_DATABASE'],
            [/MYSQL_ROOT_PASSWORD:\s*(\S+)|MYSQL_PASSWORD:\s*(\S+)/, /^DB_USER_PASSWORD=.*/m, 'DB_USER_PASSWORD'],
            [/MYSQL_USER:\s*(\S+)/, /^DB_USER_NAME=.*/m, 'DB_USER_NAME'],
            [/MYSQL_DATABASE:\s*(\S+)/, /^DB_DATABASE=.*/m, 'DB_DATABASE'],
            [/POSTGRES_PASSWORD:\s*(\S+)/, /^DB_USER_PASSWORD=.*/m, 'DB_USER_PASSWORD'],
            [/POSTGRES_USER:\s*(\S+)/, /^DB_USER_NAME=.*/m, 'DB_USER_NAME'],
            [/POSTGRES_DB:\s*(\S+)/, /^DB_DATABASE=.*/m, 'DB_DATABASE'],
            [/MSSQL_SA_PASSWORD:\s*["']?([^"'\s]+)["']?/, /^DB_USER_PASSWORD=.*/m, 'DB_USER_PASSWORD'],
          ];

          for (const [composeRe, envRe, key] of patterns) {
            const m = compose.match(composeRe);
            const val = m?.[1] ?? m?.[2];
            if (val && envRe.test(env)) {
              env = env.replace(envRe, `${key}=${val}`);
            }
          }
          // MSSQL SA 계정은 username이 항상 'SA'로 고정
          if (/MSSQL_SA_PASSWORD/.test(compose) && /^DB_USER_NAME=.*/m.test(env)) {
            env = env.replace(/^DB_USER_NAME=.*/m, 'DB_USER_NAME=SA');
          }
          writeFileSync(envPath, env);
        }
      }
    },
  });

  // Existing DB 모드에서는 seed·schema를 자동 실행하지 않는다. .env가 방금 .env.example에서
  // 복사된 플레이스홀더 상태라 DB 접속이 반드시 실패하기 때문. 사용자가 .env에 실제 접속 정보를
  // 입력한 뒤 프로젝트에 포함된 scripts/generate-schema.sh를 직접 실행하도록 안내한다.
  if (dbMode === 'docker') {
    if (withSeed) {
      steps.push({
        label: '샘플 데이터 마이그레이션 (seed.sh)',
        fn: () => {
          const result = spawnSync(pm, ['run', 'seed'], { cwd: targetDir, stdio: 'inherit' });
          if (result.status !== 0) {
            throw new Error('샘플 데이터 마이그레이션 실패');
          }
        },
        stream: true,
      });
    }

    steps.push({
      label: 'DB 스키마 인덱스 생성 (schema)',
      fn: () => {
        const result = spawnSync(pm, ['run', 'schema'], { cwd: targetDir, stdio: 'inherit' });
        if (result.status !== 0) {
          throw new Error('DB 스키마 인덱스 생성 실패');
        }
      },
      stream: true,
    });

    // ERD 는 실패해도 앱 동작에 지장 없으므로 warning 후 계속 진행
    steps.push({
      label: 'ERD 다이어그램 생성 (erd)',
      fn: () => {
        const result = spawnSync(pm, ['run', 'erd'], { cwd: targetDir, stdio: 'inherit' });
        if (result.status !== 0) {
          throw new Error('ERD 생성 실패 (스키마 문서/카탈로그 조회 문제 가능성)');
        }
      },
      stream: true,
      nonFatal: true,
    });
  }

  const total = steps.length;

  for (let i = 0; i < steps.length; i++) {
    const { label, fn, stream, nonFatal } = steps[i];
    const prefix = `[${i + 1}/${total}]`;

    if (stream) {
      console.log(pc.dim(`\n  ${prefix} ${label}...`));
      try {
        fn();
      } catch (err) {
        if (nonFatal) {
          console.log(pc.yellow(`  ${prefix} ${label} 실패 (건너뜀): ${(err as Error).message}`));
          continue;
        }
        console.log(pc.red(`  ${prefix} ${label} 실패`));
        console.log(pc.yellow(`  ${(err as Error).message}`));
        console.log('');
        console.log(pc.yellow('  자동 설정을 중단합니다. 위 오류를 해결한 뒤 Next steps를 다시 실행하세요.'));
        return;
      }
    } else {
      spinner.start(`${prefix} ${label}...`);
      try {
        fn();
        spinner.stop(`  ${prefix} ${label} 완료`);
      } catch (err) {
        if (nonFatal) {
          spinner.stop(pc.yellow(`  ${prefix} ${label} 실패 (건너뜀): ${(err as Error).message}`));
          continue;
        }
        spinner.stop(pc.red(`  ${prefix} ${label} 실패`));
        console.log(pc.yellow(`  ${(err as Error).message}`));
        console.log('');
        console.log(pc.yellow('  자동 설정을 중단합니다. 위 오류를 해결한 뒤 Next steps를 다시 실행하세요.'));
        return;
      }
    }
  }

  if (dbMode === 'existing') {
    console.log('');
    console.log(pc.yellow('  .env 파일에 DB 접속 정보를 입력한 뒤:'));
    console.log(`    ${pc.cyan(`${pm} run schema   # 스키마 인덱스 생성`)}`);
    console.log(`    ${pc.cyan(`${pm} run erd      # ERD 다이어그램 생성 (선택)`)}`);
    console.log(`    ${pc.cyan(`${pm} start`)}`);
  } else {
    console.log('');
    console.log(pc.green('  설정이 완료됐습니다!'));
    console.log(`  서버 시작: ${pc.cyan(`${pm} start`)}`);
  }
  console.log('');
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  p.intro(pc.bgCyan(pc.black(' create-database-chat ')));

  // 1. 프로젝트 이름
  let projectName = process.argv[2]?.trim() ?? '';
  if (!projectName) {
    const result = await p.text({
      message: 'Project name:',
      placeholder: 'my-database-chat',
      validate(v) {
        if (!v.trim()) return 'Project name is required.';
        if (!/^[a-z0-9][a-z0-9\-_]*$/.test(v)) return 'Use lowercase letters, numbers, hyphens, or underscores.';
        if (existsSync(path.resolve(v))) return `"${v}" already exists.`;
      },
    });
    if (isCancelled(result)) cancel();
    projectName = result;
  }

  // 2. LLM 제공자
  const providerResult = await p.select({
    message: 'LLM provider:',
    options: LLM_PROVIDERS.map(({ value, label, hint }) => ({ value, label, hint })),
  });
  if (isCancelled(providerResult)) cancel();
  const provider = providerResult as string;

  // 3. 데이터베이스
  const dbResult = await p.select({
    message: 'Database:',
    options: DATABASES.map(({ value, label, hint }) => ({ value, label, hint })),
  });
  if (isCancelled(dbResult)) cancel();
  const database = dbResult as string;

  // 4. DB 연동 방식
  const dbModeResult = await p.select({
    message: 'DB 연동 방식:',
    options: [
      { value: 'existing', label: '기존 DB 연동', hint: '.env에 접속 정보를 직접 입력' },
      { value: 'docker',   label: 'Docker로 새 DB 생성', hint: 'docker-compose.yml 자동 생성' },
    ],
  });
  if (isCancelled(dbModeResult)) cancel();
  const dbMode = dbModeResult as 'existing' | 'docker';

  // 5. 샘플 데이터 마이그레이션 (Docker 모드일 때만)
  let withSeed = false;
  if (dbMode === 'docker') {
    const seedResult = await p.confirm({
      message: '샘플 데이터를 마이그레이션하시겠어요?',
      initialValue: true,
    });
    if (isCancelled(seedResult)) cancel();
    withSeed = seedResult;
  }

  const combo = `${provider}-${database}`;

  // 아직 미지원 조합 — Docker 모드라면 docker-compose + seed 스크립트만 생성 후 안내
  if (!AVAILABLE_COMBOS.has(combo)) {
    const spinner = p.spinner();
    const targetDir = path.resolve(projectName);

    if (dbMode === 'docker') {
      spinner.start('프로젝트 파일 생성 중...');
      await generateDockerCompose(targetDir, database, projectName);
      if (withSeed) await generateSeedScript(targetDir, database, projectName);
      await generateMinimalPackageJson(targetDir, database, projectName);
      await generateEnvExample(targetDir, database);
      await generateSchemaScript(targetDir, database, provider);
      await generateErdScript(targetDir, database);
      await generateReadme(targetDir, projectName, provider, database, dbMode, withSeed, 'npm', false);
      await generateInstallScripts(targetDir, projectName, provider, database, dbMode);
      await generateStartScripts(targetDir, projectName);
      spinner.stop('프로젝트 파일 생성 완료.');

      spinner.start('npm install 중...');
      try {
        execSync('npm install', { cwd: targetDir, stdio: 'ignore' });
        spinner.stop('의존성 설치 완료.');
      } catch {
        spinner.stop(pc.yellow('⚠  npm install 실패. 직접 실행하세요.'));
      }

      console.log(pc.yellow(`\n  ⚠  ${pc.bold(combo)} 템플릿은 아직 준비 중입니다.`));
      console.log(`  docker/docker-compose.yml${withSeed ? ' 및 scripts/seed.sh' : ''} 이 ${pc.cyan(projectName + '/')} 에 생성됐습니다.`);
      console.log(`  사용 가능한 조합: ${[...AVAILABLE_COMBOS].join(', ')}\n`);

      const dockerSteps: string[] = [
        'docker compose -f docker/docker-compose.yml up -d',
        ...(withSeed ? ['bash scripts/seed.sh   # 샘플 데이터 마이그레이션 (DB 기동 후 실행)'] : []),
      ];
      const cdCmd2 = path.resolve('.') !== targetDir ? `cd ${projectName}` : null;
      console.log(pc.dim('  Next steps:'));
      for (const step of [...(cdCmd2 ? [cdCmd2] : []), ...dockerSteps]) {
        console.log(`    ${pc.cyan(step)}`);
      }
      console.log('');

      const autoDockerResult = await p.confirm({
        message: `${provider.charAt(0).toUpperCase() + provider.slice(1)}가 Docker 기동${withSeed ? ' · 샘플 데이터 · ' : ' · '}스키마 인덱스 생성까지 자동으로 실행할까요?`,
        initialValue: true,
      });
      if (!isCancelled(autoDockerResult) && autoDockerResult) {
        console.log('');
        console.log(pc.dim(`  ${provider}이(가) Docker 기동부터 스키마 인덱스 생성까지 자동 실행합니다...`));
        console.log('');
        const prompt = buildDockerSeedPrompt(withSeed, 'npm');
        if (provider === 'claude') {
          const model = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
          const result = spawnSync(
            'claude',
            ['-p', prompt, '--allowedTools', 'Bash', '--model', model, '--max-turns', '20'],
            { cwd: targetDir, stdio: 'inherit' },
          );
          if (result.status !== 0) {
            console.log(pc.yellow('\n⚠  Auto-setup에 문제가 발생했습니다. 위 출력 내용을 확인하세요.'));
          }
        } else if (provider === 'codex') {
          const codexBin = process.env.CODEX_CLI_PATH
            ?? (existsSync('/Applications/ChatGPT.app/Contents/Resources/codex')
              ? '/Applications/ChatGPT.app/Contents/Resources/codex'
              : 'codex');
          const model = process.env.CODEX_MODEL?.trim() || 'gpt-5.6-luna';
          const result = spawnSync(
            codexBin,
            [
              'exec',
              '--skip-git-repo-check',
              '--sandbox', 'danger-full-access',
              '--model', model,
              prompt,
            ],
            { cwd: targetDir, stdio: 'inherit' },
          );
          if (result.status !== 0) {
            console.log(pc.yellow('\n⚠  Auto-setup에 문제가 발생했습니다. 위 출력 내용을 확인하세요.'));
          }
        } else {
          console.log(pc.yellow(`\n⚠  ${provider} auto-setup은 아직 지원되지 않습니다. Next steps를 직접 실행해주세요.`));
        }
      }
      p.outro(pc.green('완료!'));
    } else {
      p.outro(
        pc.yellow(`⚠  ${pc.bold(combo)} 템플릿은 아직 준비 중입니다.\n`) +
        `   사용 가능한 조합: ${[...AVAILABLE_COMBOS].join(', ')}`
      );
    }
    process.exit(0);
  }

  // 5. 패키지 매니저
  const defaultPm = detectPackageManager();
  const pmResult = await p.select({
    message: 'Package manager:',
    options: PACKAGE_MANAGERS.map((v) => ({
      value: v,
      label: v,
      hint: v === defaultPm ? 'detected' : undefined,
    })),
    initialValue: defaultPm,
  });
  if (isCancelled(pmResult)) cancel();
  const pm = pmResult as PackageManager;

  // ── 프로젝트 생성 ──────────────────────────────────────────────────────────

  const targetDir = path.resolve(projectName);
  const templateDir = path.join(TEMPLATES_DIR, combo);

  const spinner = p.spinner();

  // 파일 복사
  spinner.start('Copying template files...');
  await mkdir(targetDir, { recursive: true });
  await cp(templateDir, targetDir, { recursive: true });

  // _gitignore → .gitignore (git이 template 내 .gitignore를 무시하는 문제 회피)
  const gitignoreSrc = path.join(targetDir, '_gitignore');
  if (existsSync(gitignoreSrc)) {
    await rename(gitignoreSrc, path.join(targetDir, '.gitignore'));
  }

  // package.json의 name 필드를 프로젝트명으로 교체
  await updatePackageName(targetDir, projectName);

  // Docker 모드: DB에 맞는 docker-compose.yml 생성 (템플릿 파일 덮어쓰기)
  if (dbMode === 'docker') {
    await generateDockerCompose(targetDir, database, projectName);
  }

  // 샘플 데이터: seed.sh 복사 + package.json에 seed 스크립트 추가
  if (withSeed) {
    await generateSeedScript(targetDir, database, projectName);
    await addSeedScript(targetDir);
  }

  // generate-schema.ts 복사 + package.json에 schema 스크립트 추가
  await generateSchemaScript(targetDir, database, provider);
  await addSchemaToPackageScripts(targetDir);

  // generate-erd.ts 복사 + package.json에 erd 스크립트 추가
  await generateErdScript(targetDir, database);
  await addErdToPackageScripts(targetDir);

  // README.md 생성
  await generateReadme(targetDir, projectName, provider, database, dbMode, withSeed, pm, true);

  // install 스크립트 생성 (install.sh / install.bat)
  await generateInstallScripts(targetDir, projectName, provider, database, dbMode);

  // start 스크립트 생성 (start.sh / start.bat)
  await generateStartScripts(targetDir, projectName);

  spinner.stop('Template files copied.');

  // 의존성 설치
  const installCmd: Record<PackageManager, string> = {
    npm: 'npm install',
    pnpm: 'pnpm install',
    yarn: 'yarn',
  };
  spinner.start(`Installing dependencies via ${pm}...`);
  try {
    execSync(installCmd[pm], { cwd: targetDir, stdio: 'ignore' });
    spinner.stop('Dependencies installed.');
  } catch {
    spinner.stop(pc.yellow('⚠  Dependency install failed. Run it manually.'));
  }

  // ── 완료 메시지 ────────────────────────────────────────────────────────────

  p.outro(pc.green(`✔  Project ${pc.bold(projectName)} is ready!`));

  // cd 명령은 LLM이 이미 targetDir에서 실행하므로 자동 실행 프롬프트에선 제외
  const cdCmd = path.resolve('.') !== targetDir ? `cd ${projectName}` : null;
  const setupSteps: string[] = [
    ...(dbMode === 'docker'
      ? ['docker compose -f docker/docker-compose.yml up -d']
      : []),
    ...(withSeed
      ? [`${pm} run seed   # 샘플 데이터 마이그레이션 (DB 기동 후 실행)`]
      : []),
    'cp .env.example .env',
    `${pm} run schema   # DB 스키마 자동 추출 → index.md / ${database === 'mongodb' ? 'collection' : 'table'}-mapping.md 생성`,
    ...(dbMode === 'existing' ? ['# .env에 DB 접속 정보를 입력하세요'] : []),
    ...(withSeed ? ['# seed 완료 후 .env의 DB_DATABASE를 안내에 따라 변경하세요'] : []),
    `${pm} start`,
  ];


  // 화면 표시용 (cd 포함)
  const displaySteps = [...(cdCmd ? [cdCmd] : []), ...setupSteps];
  console.log(pc.dim('  Next steps:'));
  for (const step of displaySteps) {
    console.log(`    ${pc.cyan(step)}`);
  }
  console.log('');

  // Auto-setup 여부 확인
  const autoResult = await p.confirm({
    message: `${provider.charAt(0).toUpperCase() + provider.slice(1)}가 위 과정을 자동으로 실행할까요?`,
    initialValue: true,
  });
  if (!isCancelled(autoResult) && autoResult) {
    console.log('');
    console.log(pc.dim(`  ${provider}이(가) 설정을 자동 실행합니다...`));
    console.log('');
    await runAutoSetup(targetDir, provider, pm, dbMode, database, withSeed);
  }
  console.log('');
}

main().catch((err: unknown) => {
  console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
  process.exit(1);
});
