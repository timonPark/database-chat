---
status: accepted
---

# `/db-export` 를 **서버 측 xlsx 생성·저장** 으로 전환한다

기존에는 서버가 `{ count, data, collection }` JSON 만 반환하고 **클라이언트** 가 CDN `xlsx` 라이브러리로 엑셀을 생성·다운로드했다. Export 보관·재다운로드·Session 복원 요구가 생기면서 **파일의 단일 진실 공급원이 서버로 이동** 할 필요가 생겼다. 서버가 npm `xlsx` (SheetJS, 클라이언트 CDN 과 동일 API) 로 xlsx 를 생성해 `data/exports/<sid>/<mid>-<ts>.xlsx` 로 저장하고 응답에 `{ exportId, downloadUrl, fileName, fileSize, rowCount }` 를 담아 돌려준다. 클라이언트는 `downloadUrl` 로 다운로드만 트리거.

## Considered Options

- **서버 생성·저장 (채택)**: 재다운로드·Session 복원·고아파일 정리가 서버 로직 하나로 수렴. Attachment 상한 초과 자동 승격 룰도 서버에서 자연스럽게 성립. 서버 번들에 `xlsx` 의존성 추가 (≈ 1MB).
- **클라이언트 생성 유지 + blob 업로드**: 클라이언트가 바이트를 만들어 멀티파트 업로드 → 서버는 저장만. 네트워크 2회 왕복 + 서버가 생성 로직을 못 가져 재다운로드 시 "클라이언트가 올린 바이트 그대로 되돌려주는 서비스" 로 축소. Attachment 상한 승격이 서버에서 할 수 없게 되어 규칙이 축에 안 맞게 된다.

## Consequences

- 각 템플릿 `package.json` 에 `xlsx` 의존성이 추가된다 (클라이언트 CDN 로드는 유지해도 되고 제거해도 됨 — 서버가 담당하므로 CDN 는 제거 권장).
- 재다운로드는 `GET /exports/:id/download` 하나로 통일된다. 파일 missing 시 404 + DB 레코드 자동 삭제.
- Attachment 가 10MB 를 넘기면 서버가 **동일 코드 경로** 로 xlsx 생성·저장 → `exports` 레코드 INSERT → attachment 는 `table-ref` 로 축약 저장.
