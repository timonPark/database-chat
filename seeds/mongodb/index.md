# 컬렉션 인덱스 — MongoDB Atlas Sample Datasets
> **database**: `sample_mflix` (기본값 — .env의 DB_DATABASE 로 변경 가능)
> 최종 업데이트: 2024-11-01

## 데이터베이스 목록

| 데이터베이스 | 설명 |
|------------|------|
| `sample_mflix` | 영화·댓글·사용자·영화관 |
| `sample_analytics` | 금융 고객·계좌·거래 |
| `sample_airbnb` | 에어비앤비 숙소·리뷰 |
| `sample_restaurants` | 뉴욕 음식점 |
| `sample_supplies` | 판매·매출 |
| `sample_training` | 성적·기업·항공노선 등 |
| `sample_geospatial` | 난파선 위치 |
| `sample_weatherdata` | 기상 측정 데이터 |

## sample_mflix 컬렉션 목록

### 영화
| 컬렉션명 | 한글 설명 |
|---------|---------|
| `movies` | 영화 정보 (21,349건) |
| `comments` | 영화 댓글 (41,079건) |
| `users` | 사용자 계정 (185건) |
| `theaters` | 영화관 위치 (1,564건) |
| `embedded_movies` | 임베디드 영화 데이터 (3,483건) |

---

## 필드 타입 규칙

- `_id` → MongoDB ObjectId
- `date` / `released` → Date 객체
- `imdb.rating` → Number
