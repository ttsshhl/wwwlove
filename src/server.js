import express from "express";
import cors from "cors";
import { customAlphabet } from "nanoid";
import db from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

const id = () => customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16)();
// Код пары без похожих символов (без 0/O, 1/I)
const makeCode = customAlphabet("0123456789", 6);

const now = () => Date.now();

// Утилита: найти/создать пользователя по device_id
function ensureUser(deviceId) {
  let u = db.prepare("SELECT * FROM users WHERE device_id = ?").get(deviceId);
  if (!u) {
    const uid = id();
    db.prepare("INSERT INTO users (id, device_id, created_at) VALUES (?, ?, ?)").run(uid, deviceId, now());
    u = { id: uid, device_id: deviceId };
  }
  return u;
}

// Найти пару пользователя
function findPair(userId) {
  return db.prepare("SELECT * FROM pairs WHERE user_a = ? OR user_b = ?").get(userId, userId);
}

// --- health ---
app.get("/", (req, res) => res.json({ ok: true, service: "wwwlove" }));

// --- регистрация устройства ---
// body: { deviceId }
app.post("/api/register", (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const u = ensureUser(deviceId);
  const pair = findPair(u.id);
  res.json({ userId: u.id, pair: pair ? publicPair(pair, u.id) : null });
});

// --- создать код пары ---
// body: { deviceId }
app.post("/api/pair/create", (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const u = ensureUser(deviceId);

  let existing = findPair(u.id);
  if (existing) return res.json({ code: existing.code, pair: publicPair(existing, u.id) });

  let code;
  do { code = makeCode(); } while (db.prepare("SELECT 1 FROM pairs WHERE code = ?").get(code));

  const pid = id();
  db.prepare("INSERT INTO pairs (id, code, user_a, created_at) VALUES (?, ?, ?, ?)").run(pid, code, u.id, now());
  const pair = db.prepare("SELECT * FROM pairs WHERE id = ?").get(pid);
  res.json({ code, pair: publicPair(pair, u.id) });
});

// --- привязаться по коду ---
// body: { deviceId, code }
app.post("/api/pair/join", (req, res) => {
  const { deviceId, code } = req.body || {};
  if (!deviceId || !code) return res.status(400).json({ error: "deviceId and code required" });
  const u = ensureUser(deviceId);

  const pair = db.prepare("SELECT * FROM pairs WHERE code = ?").get(String(code).toUpperCase());
  if (!pair) return res.status(404).json({ error: "Код не найден" });
  if (pair.user_a === u.id) return res.status(400).json({ error: "Это ваш собственный код" });
  if (pair.user_b && pair.user_b !== u.id) return res.status(409).json({ error: "К этой паре уже кто-то привязан" });

  db.prepare("UPDATE pairs SET user_b = ? WHERE id = ?").run(u.id, pair.id);
  const updated = db.prepare("SELECT * FROM pairs WHERE id = ?").get(pair.id);
  res.json({ pair: publicPair(updated, u.id) });
});

// --- статус пары (поллинг: привязался ли партнёр) ---
// query: ?deviceId=...
app.get("/api/pair/status", (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const u = ensureUser(deviceId);
  const pair = findPair(u.id);
  res.json({ pair: pair ? publicPair(pair, u.id) : null });
});

// --- сохранить дату начала отношений ---
// body: { deviceId, startDate }
app.post("/api/pair/start-date", (req, res) => {
  const { deviceId, startDate } = req.body || {};
  const u = ensureUser(deviceId);
  const pair = findPair(u.id);
  if (!pair) return res.status(404).json({ error: "Пара не найдена" });
  db.prepare("UPDATE pairs SET start_date = ? WHERE id = ?").run(startDate, pair.id);
  res.json({ ok: true });
});

// --- отметить премиум (после успешной покупки; проверку покупки делает платёжный слой) ---
app.post("/api/pair/premium", (req, res) => {
  const { deviceId } = req.body || {};
  const u = ensureUser(deviceId);
  const pair = findPair(u.id);
  if (!pair) return res.status(404).json({ error: "Пара не найдена" });
  db.prepare("UPDATE pairs SET premium = 1 WHERE id = ?").run(pair.id);
  res.json({ ok: true });
});

// --- отправить ответ ---
// body: { deviceId, catId, qText, answer, isChoice }
app.post("/api/answers", (req, res) => {
  const { deviceId, catId, qText, answer, isChoice } = req.body || {};
  if (!deviceId || !catId || !qText || answer == null) return res.status(400).json({ error: "missing fields" });
  const u = ensureUser(deviceId);
  const pair = findPair(u.id);
  if (!pair) return res.status(404).json({ error: "Пара не найдена" });

  const aid = id();
  db.prepare(`INSERT INTO answers (id, pair_id, user_id, cat_id, q_text, answer, is_choice, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(aid, pair.id, u.id, catId, qText, String(answer), isChoice ? 1 : 0, now());
  res.json({ ok: true, id: aid });
});

// --- лента ответов пары (для «Книги пары»): группируем по вопросу, показываем оба ответа ---
// query: ?deviceId=...
app.get("/api/answers", (req, res) => {
  const { deviceId } = req.query;
  const u = ensureUser(deviceId);
  const pair = findPair(u.id);
  if (!pair) return res.json({ entries: [] });

  const rows = db.prepare("SELECT * FROM answers WHERE pair_id = ? ORDER BY created_at DESC").all(pair.id);
  // Сгруппировать по (cat_id, q_text): мой ответ + ответ партнёра
  const map = new Map();
  for (const r of rows) {
    const key = r.cat_id + "|" + r.q_text;
    if (!map.has(key)) map.set(key, { catId: r.cat_id, q: r.q_text, isChoice: !!r.is_choice, mine: null, theirs: null, ts: r.created_at });
    const e = map.get(key);
    if (r.user_id === u.id) e.mine = r.answer;
    else e.theirs = r.answer;
  }
  const entries = [...map.values()]
    .filter((e) => e.mine != null) // показываем только то, на что ответил сам пользователь
    .map((e) => ({ ...e, matched: e.isChoice && e.theirs != null && e.mine === e.theirs }));
  res.json({ entries });
});

function publicPair(pair, meId) {
  const partnerId = pair.user_a === meId ? pair.user_b : pair.user_a;
  return {
    id: pair.id,
    code: pair.code,
    connected: !!pair.user_b,
    isCreator: pair.user_a === meId,
    partnerJoined: !!partnerId,
    startDate: pair.start_date || "",
    premium: !!pair.premium,
  };
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => console.log(`WwwLove server on port ${PORT}`));
