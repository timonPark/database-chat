# Oracle Instant Client 설치 가이드

`node-oracledb` 6.x는 순수 JavaScript로 구현된 **Thin 모드가 기본**이므로 대부분의 조합 템플릿에서는 Instant Client를 설치할 필요가 없습니다. 특정 고급 기능이 필요한 경우에만 **Thick 모드**로 전환하며, 이때 Instant Client가 요구됩니다.

## Thin vs Thick 모드 비교

| 항목 | Thin (기본) | Thick |
| --- | --- | --- |
| 언어 | 순수 JavaScript | C 라이브러리 바인딩 (OCI) |
| 사전 설치 | 없음 (`npm install oracledb`만) | Oracle Instant Client 필요 |
| 지원 Oracle 버전 | 12.1 이상 | 11.2 이상 |
| Easy Connect (`HOST:PORT/SERVICE`) | ✅ | ✅ |
| TNSNAMES.ora / wallet | 제한적 | ✅ 완전 지원 |
| TLS/SSL | 기본 지원 (일반적 시나리오) | ✅ (mTLS 등 고급 옵션 포함) |
| Application Continuity | ❌ | ✅ |
| Advanced Queuing | ❌ | ✅ |
| XMLType | ❌ (문자열/CLOB 우회) | ✅ |
| Sharding | ❌ | ✅ |
| Kerberos·RADIUS 등 고급 인증 | ❌ | ✅ |

기준 구현([`templates/claude-oracle/server.ts`](../../templates/claude-oracle/server.ts))은 Thin 모드로만 동작하도록 작성돼 있습니다 — 코드에 `oracledb.initOracleClient(...)` 호출이 없습니다.

## 언제 Thick 모드가 필요한가

다음 중 하나라도 해당하면 Instant Client 설치와 Thick 모드 활성화가 필요합니다:

1. Oracle DB 버전이 **12.1 미만** (11.2까지 지원 확대 필요).
2. **TNSNAMES.ora / wallet**로만 접속 정보를 관리해야 하는 정책 (Easy Connect 사용 금지).
3. Oracle Cloud Autonomous DB의 **wallet 기반 mTLS** 접속.
4. **Application Continuity**로 무중단 fail-over가 필요.
5. **Advanced Queuing**·**Sharding**·**XMLType**을 SQL/PL/SQL 안에서 활용.
6. Kerberos·RADIUS·PKI 등 **비표준 인증** 방식 사용.

위에 해당하지 않으면 Instant Client 없이 Thin 모드로 그대로 운영합니다.

## 설치 — macOS

Homebrew 사용:

```bash
brew tap InstantClientTap/instantclient
brew install instantclient-basic

# 설치 위치 확인
brew --prefix instantclient-basic
# 예: /opt/homebrew/opt/instantclient-basic (Apple Silicon)
# 또는 /usr/local/opt/instantclient-basic (Intel)
```

수동 설치(`.dmg` 또는 `.zip`)는 Oracle 공식 페이지에서 다운로드 후 임의 경로에 압축 해제:

```bash
mkdir -p ~/oracle
cd ~/oracle
unzip ~/Downloads/instantclient-basic-macos-*.zip
# → ~/oracle/instantclient_23_3/
```

Apple Silicon(arm64) Mac은 Oracle이 아직 arm64 네이티브 Instant Client를 릴리스하지 않은 시점(2024년 기준)에는 Rosetta로 실행해야 할 수 있습니다. 최신 릴리스 상태는 Oracle 공식 페이지에서 확인.

## 설치 — Linux

`.zip` 다운로드 후 압축 해제:

```bash
sudo mkdir -p /opt/oracle
cd /opt/oracle
sudo unzip ~/Downloads/instantclient-basic-linux.x64-*.zip
# → /opt/oracle/instantclient_23_3/

# libaio 런타임 의존성 설치 (배포판별 상이)
sudo apt-get install -y libaio1     # Debian/Ubuntu
sudo yum install -y libaio          # RHEL/CentOS
```

시스템 라이브러리 경로 등록 (권장):

```bash
echo /opt/oracle/instantclient_23_3 | sudo tee /etc/ld.so.conf.d/oracle-instantclient.conf
sudo ldconfig
```

또는 프로세스 환경 변수로만 지정:

```bash
export LD_LIBRARY_PATH=/opt/oracle/instantclient_23_3:$LD_LIBRARY_PATH
```

## 설치 — Windows

1. Oracle 공식 페이지에서 **Instant Client Basic (Windows x64)** `.zip` 다운로드.
2. 임의 폴더(예: `C:\oracle\instantclient_23_3`)에 압축 해제.
3. 시스템 환경 변수 `PATH`에 해당 폴더 추가:

   ```powershell
   [Environment]::SetEnvironmentVariable(
     'PATH',
     "$env:PATH;C:\oracle\instantclient_23_3",
     [EnvironmentVariableTarget]::Machine
   )
   ```

4. 새 셸/서비스에서 반영 확인 (`echo %PATH%`).
5. Visual C++ Redistributable(현행 Instant Client가 요구하는 버전)이 설치돼 있는지 확인 — 없으면 Microsoft에서 별도 설치.

## Thick 모드 활성화

Instant Client 설치 후, 서버 코드 시작 지점(다른 `oracledb` 호출 이전)에 `initOracleClient()`를 호출하면 Thick 모드로 동작합니다. `libDir`를 지정하지 않으면 OS 라이브러리 검색 경로(`LD_LIBRARY_PATH`, `PATH`, `DYLD_LIBRARY_PATH`)에서 자동 탐색합니다.

```ts
import oracledb from 'oracledb';

// PATH / LD_LIBRARY_PATH 등록이 돼 있으면 인자 없이 호출
oracledb.initOracleClient();

// 또는 명시적으로 경로 지정
oracledb.initOracleClient({
  libDir: process.env.ORACLE_CLIENT_DIR ?? '/opt/oracle/instantclient_23_3',
});

// 이후 createPool()·getConnection() 등을 그대로 사용
```

- `initOracleClient()`는 프로세스 수명 동안 **한 번만** 호출. 두 번 호출하면 예외.
- 다른 `oracledb` API를 호출한 이후에 실행하면 Thin 모드로 확정되어 Thick로 전환 불가.
- macOS는 `DYLD_LIBRARY_PATH`를 대신 사용 (일부 시스템은 SIP 보호로 무시됨 — 이 경우 `libDir` 명시).

## 새 조합 템플릿에 Thick 모드 통합할 때 체크리스트

1. Instant Client 설치를 `install.sh` / `install.bat` / README에 명시.
2. 서버 코드 최상단(다른 `oracledb` 호출 이전)에 `oracledb.initOracleClient({ libDir: ... })` 추가.
3. `libDir` 값은 `.env`에서 관리하고 `.env.example`에 예시 추가 (예: `ORACLE_CLIENT_DIR=/opt/oracle/instantclient_23_3`).
4. Thin 모드 전용 기능(예: 특정 wallet 접속)을 사용하지 않는 조합에서는 Thick 모드로 전환하지 말 것 — 배포·설치가 복잡해집니다.
5. Docker 이미지로 배포 시 Instant Client를 이미지 안에 함께 담고 `LD_LIBRARY_PATH`를 `ENV`로 설정.

## 문제 해결

**증상 → 원인 → 대응**

- `DPI-1047: Cannot locate a 64-bit Oracle Client library` — 라이브러리 검색 경로에 Instant Client가 없음. `PATH`/`LD_LIBRARY_PATH` 재확인 또는 `libDir` 명시.
- `NJS-138: Thin mode does not support ...` (기능명) — Thin 모드로 지원되지 않는 API 사용. Thick 모드 활성화 필요.
- macOS `code signing` 오류 — Instant Client `.dylib`에 대해 quarantine attribute 제거: `xattr -d com.apple.quarantine <path>/*.dylib`.
- Windows `MSVCR120.dll이 없어 프로그램을 시작할 수 없습니다` — Visual C++ Redistributable 미설치. Microsoft에서 재설치.

## 참고 링크

- Oracle Instant Client: <https://www.oracle.com/database/technologies/instant-client.html>
- `node-oracledb` Thin vs Thick 모드: <https://node-oracledb.readthedocs.io/en/latest/user_guide/appendix_a.html>
- `initOracleClient()` API: <https://node-oracledb.readthedocs.io/en/latest/api_manual/oracledb.html#oracledb-initoracleclient>
