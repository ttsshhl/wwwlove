import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// На Railway монтируем постоянный диск (Volume) и указываем его путь в DB_DIR,
// чтобы база не терялась при передеплоях. Локально — файл рядом с проектом.
const dbDir = process.env.DB_DIR || join(__dirname, "..");
const db = new DatabaseSync(join(dbDir, "wwwlove.db"));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  device_id TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairs (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  user_a TEXT NOT NULL,
  user_b TEXT,
  start_date TEXT,
  premium INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cat_id TEXT NOT NULL,
  q_text TEXT NOT NULL,
  answer TEXT NOT NULL,
  is_choice INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answers_pair ON answers(pair_id);
`);

export default db;
