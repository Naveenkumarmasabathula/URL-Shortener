-- Database-per-service: urls DB (shorten + redirect), analytics DB (analytics)
CREATE DATABASE analytics;

\c postgres
CREATE SEQUENCE IF NOT EXISTS url_id_seq START 100000000000;  -- 7-char Base62 codes

CREATE TABLE IF NOT EXISTS urls (
  id         BIGINT PRIMARY KEY,
  code       VARCHAR(32) UNIQUE NOT NULL,
  long_url   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_urls_code ON urls(code);

\c analytics
CREATE TABLE IF NOT EXISTS clicks (
  id         BIGSERIAL PRIMARY KEY,
  code       VARCHAR(32) NOT NULL,
  clicked_at TIMESTAMPTZ NOT NULL,
  ip         VARCHAR(64),
  user_agent TEXT,
  referer    TEXT
);
CREATE INDEX IF NOT EXISTS idx_clicks_code_time ON clicks(code, clicked_at DESC);
