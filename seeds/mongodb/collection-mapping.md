# 컬렉션 자연어 매핑 정의서

> **database**: `sample_mflix` — MongoDB Atlas 공식 샘플 데이터셋

---

## 영화 (sample_mflix)

| 컬렉션명 | 자연어 키워드 | 주요 필드 | 설명 |
|---------|-------------|---------|------|
| `movies` | 영화, 무비, 작품, 감독, 장르, 배우 | `title`, `year`, `genres`, `directors`, `cast`, `imdb.rating`, `countries`, `runtime` | 영화 정보 (21,349건) |
| `comments` | 댓글, 리뷰, 코멘트, 영화평 | `name`, `email`, `movie_id`, `text`, `date` | 영화 댓글 (41,079건) |
| `users` | 사용자, 유저, 회원 | `name`, `email` | 사용자 계정 (185건) |
| `theaters` | 영화관, 극장, 상영관 | `theaterId`, `location.address.city`, `location.address.state` | 영화관 위치 (1,564건) |
| `embedded_movies` | 임베디드영화 | `title`, `year`, `genres`, `cast` | 임베디드 영화 데이터 (3,483건) |
