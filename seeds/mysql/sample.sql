-- database-chat 샘플 데이터 (MySQL 8.0)

CREATE DATABASE IF NOT EXISTS mydb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE mydb;

DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id         INT          PRIMARY KEY AUTO_INCREMENT,
  name       VARCHAR(50)  NOT NULL,
  email      VARCHAR(100) NOT NULL UNIQUE,
  age        INT,
  city       VARCHAR(50),
  joined_at  DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE products (
  id        INT            PRIMARY KEY AUTO_INCREMENT,
  name      VARCHAR(100)   NOT NULL,
  category  VARCHAR(50),
  price     INT            NOT NULL,
  stock     INT            DEFAULT 0,
  rating    DECIMAL(2, 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE orders (
  id          INT         PRIMARY KEY AUTO_INCREMENT,
  user_id     INT         NOT NULL,
  product_id  INT         NOT NULL,
  quantity    INT         DEFAULT 1,
  amount      INT         NOT NULL,
  status      ENUM('pending','completed','cancelled','refunded') DEFAULT 'pending',
  ordered_at  DATETIME    DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)    REFERENCES users(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── users ──────────────────────────────────────────────────────────────────
INSERT INTO users (name, email, age, city, joined_at) VALUES
('김민준', 'minjun@example.com',   28, '서울', '2022-03-15'),
('이서연', 'seoyeon@example.com',  34, '부산', '2022-05-20'),
('박준혁', 'junhyeok@example.com', 25, '인천', '2022-07-08'),
('최유진', 'yujin@example.com',    31, '대구', '2022-09-11'),
('정민서', 'minseo@example.com',   27, '대전', '2022-11-03'),
('강현우', 'hyunwoo@example.com',  42, '광주', '2023-01-19'),
('조예린', 'yerin@example.com',    29, '수원', '2023-02-28'),
('윤성훈', 'sunghoon@example.com', 38, '울산', '2023-04-05'),
('장나은', 'naeun@example.com',    23, '성남', '2023-05-17'),
('임도현', 'dohyun@example.com',   45, '고양', '2023-06-30'),
('한지민', 'jimin@example.com',    33, '용인', '2023-08-12'),
('신수아', 'sua@example.com',      26, '창원', '2023-09-24'),
('오민혁', 'minhyeok@example.com', 37, '청주', '2023-10-31'),
('배소희', 'sohee@example.com',    30, '전주', '2023-12-06'),
('서준영', 'junyeong@example.com', 22, '천안', '2024-01-15'),
('남지훈', 'jihoon@example.com',   41, '안산', '2024-02-22'),
('류아영', 'ayoung@example.com',   35, '원주', '2024-03-14'),
('문현진', 'hyunjin@example.com',  28, '포항', '2024-05-09'),
('전채원', 'chaewon@example.com',  32, '제주', '2024-07-03'),
('양건우', 'geonwoo@example.com',  48, '춘천', '2024-08-18');

-- ── products ───────────────────────────────────────────────────────────────
INSERT INTO products (name, category, price, stock, rating) VALUES
('무선 이어폰',   '전자기기', 89000,  150, 4.5),
('노트북 파우치', '액세서리', 25000,  80,  4.2),
('스마트워치',    '전자기기', 320000, 45,  4.7),
('텀블러',        '생활용품', 32000,  200, 4.3),
('무선 충전기',   '전자기기', 45000,  120, 4.1),
('캐리어 20인치', '여행용품', 85000,  30,  4.6),
('요가 매트',     '스포츠',   28000,  95,  4.4),
('전동 칫솔',     '헬스케어', 65000,  60,  4.8),
('독서대',        '학습용품', 22000,  110, 4.0),
('핸드크림 세트', '뷰티',     18000,  250, 4.3);

-- ── orders ─────────────────────────────────────────────────────────────────
INSERT INTO orders (user_id, product_id, quantity, amount, status, ordered_at) VALUES
(1,  3,  1, 320000, 'completed',  '2023-01-05 10:23:00'),
(2,  1,  2, 178000, 'completed',  '2023-01-12 14:05:00'),
(3,  5,  1, 45000,  'completed',  '2023-02-03 09:11:00'),
(4,  8,  1, 65000,  'completed',  '2023-02-18 16:40:00'),
(5,  4,  3, 96000,  'completed',  '2023-03-07 11:30:00'),
(6,  2,  1, 25000,  'cancelled',  '2023-03-22 13:55:00'),
(7,  6,  1, 85000,  'completed',  '2023-04-14 08:20:00'),
(8,  10, 2, 36000,  'completed',  '2023-04-29 15:10:00'),
(9,  7,  1, 28000,  'refunded',   '2023-05-16 10:45:00'),
(10, 1,  1, 89000,  'completed',  '2023-05-31 12:00:00'),
(11, 9,  2, 44000,  'completed',  '2023-06-10 17:35:00'),
(12, 3,  1, 320000, 'completed',  '2023-06-25 09:50:00'),
(13, 5,  2, 90000,  'completed',  '2023-07-08 14:20:00'),
(14, 4,  1, 32000,  'pending',    '2023-07-19 11:15:00'),
(15, 8,  1, 65000,  'completed',  '2023-08-02 16:00:00'),
(16, 6,  2, 170000, 'completed',  '2023-08-20 10:30:00'),
(17, 2,  3, 75000,  'completed',  '2023-09-04 13:45:00'),
(18, 7,  2, 56000,  'cancelled',  '2023-09-18 09:25:00'),
(19, 10, 4, 72000,  'completed',  '2023-10-05 15:55:00'),
(20, 1,  1, 89000,  'completed',  '2023-10-22 11:10:00'),
(1,  8,  1, 65000,  'completed',  '2023-11-03 14:40:00'),
(2,  9,  2, 44000,  'completed',  '2023-11-17 10:05:00'),
(3,  3,  1, 320000, 'refunded',   '2023-12-01 16:30:00'),
(4,  5,  1, 45000,  'completed',  '2023-12-14 09:00:00'),
(5,  6,  1, 85000,  'completed',  '2023-12-28 13:20:00'),
(6,  10, 3, 54000,  'completed',  '2024-01-08 10:50:00'),
(7,  4,  2, 64000,  'completed',  '2024-01-20 15:15:00'),
(8,  1,  1, 89000,  'pending',    '2024-02-05 11:35:00'),
(9,  2,  2, 50000,  'completed',  '2024-02-19 14:00:00'),
(10, 7,  1, 28000,  'completed',  '2024-03-03 09:40:00'),
(11, 8,  2, 130000, 'completed',  '2024-03-15 16:25:00'),
(12, 5,  1, 45000,  'cancelled',  '2024-03-28 12:10:00'),
(13, 9,  3, 66000,  'completed',  '2024-04-10 10:30:00'),
(14, 3,  1, 320000, 'completed',  '2024-04-22 14:55:00'),
(15, 10, 2, 36000,  'completed',  '2024-05-06 11:20:00'),
(16, 6,  1, 85000,  'completed',  '2024-05-18 09:45:00'),
(17, 1,  2, 178000, 'completed',  '2024-06-01 15:30:00'),
(18, 4,  4, 128000, 'completed',  '2024-06-14 10:05:00'),
(19, 7,  1, 28000,  'refunded',   '2024-06-27 13:40:00'),
(20, 2,  1, 25000,  'completed',  '2024-07-09 16:00:00'),
(1,  5,  2, 90000,  'completed',  '2024-07-22 11:50:00'),
(2,  8,  1, 65000,  'pending',    '2024-08-03 14:15:00'),
(3,  10, 5, 90000,  'completed',  '2024-08-16 09:30:00'),
(4,  6,  1, 85000,  'completed',  '2024-08-29 15:45:00'),
(5,  9,  2, 44000,  'completed',  '2024-09-10 12:20:00'),
(6,  3,  1, 320000, 'completed',  '2024-09-23 10:00:00'),
(7,  1,  1, 89000,  'completed',  '2024-10-05 14:35:00'),
(8,  4,  2, 64000,  'cancelled',  '2024-10-18 11:10:00'),
(9,  7,  3, 84000,  'completed',  '2024-10-31 16:55:00'),
(10, 2,  2, 50000,  'completed',  '2024-11-12 09:20:00');
