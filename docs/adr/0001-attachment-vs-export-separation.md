---
status: accepted
---

# Attachment 와 Export 를 별개 개념으로 분리한다

Message 에 매달리는 결과물을 두 축으로 명시 분리한다. **Attachment** = 쿼리 결과의 자동 스냅샷 (Session 복원용, DB JSON 임베드), **Export** = 사용자가 명시적으로 받은 엑셀 파일 (재다운로드 대상, 디스크 바이너리). 저장 형식이 다를 뿐 아니라 **의미(생성 의도·수명 관리·CASCADE 범위·크기 처리 규칙)** 가 다르기 때문이다.

## Considered Options

- **단일 "결과물" 개념** (대안): 모든 결과물을 하나의 테이블·JSON 포맷으로. 거절 이유 — "엑셀 결과도 attachment 아닌가?" 식 혼동이 PR·리뷰·테스트 가정에서 되살아남. Attachment 상한 처리 룰이 자연스럽게 엮이지 않음.
- **분리 유지 (채택)**: Attachment 상한 초과 시 자동으로 Export 로 **승격**하는 룰이 두 축을 유연하게 연결함. CASCADE·고아파일 정리·세션 복원 로직이 모두 축에 깔끔히 떨어짐.

## Consequences

- 코드·문서·대화에서 두 단어를 혼용하지 않는다 (`GLOSSARY.md` 참조).
- `messages.attachments` 가 상한을 넘으면 서버가 자동으로 Export 로 승격하고 attachment 에는 `{ type: 'table-ref', exportId }` 만 둔다.
- Session 삭제 시 messages (와 그 안의 attachments) + exports 레코드 + 디스크 파일/폴더가 모두 CASCADE 로 함께 제거된다.
