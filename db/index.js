const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_DIR = path.join(__dirname, "../data");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, "pendosa.db"));

// Enable WAL mode for better concurrent performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ───────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id  TEXT UNIQUE NOT NULL,
    username    TEXT NOT NULL,
    avatar      TEXT,
    tier        TEXT NOT NULL DEFAULT 'free',
    uploads_used INTEGER NOT NULL DEFAULT 0,
    reset_date  TEXT NOT NULL DEFAULT (strftime('%Y-%m-01', 'now')),
    roblox_user_id TEXT,
    roblox_group_id TEXT,
    roblox_api_key TEXT,
    creator_type TEXT DEFAULT 'user',
    banned      INTEGER NOT NULL DEFAULT 0,
    ban_reason  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS upload_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    filename    TEXT NOT NULL,
    asset_id    TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    error       TEXT,
    file_size   INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payment_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    target_tier TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    proof_url   TEXT,
    proof_filename TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    note        TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS server_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL DEFAULT 'info',
    msg         TEXT NOT NULL,
    user_id     INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_discord ON users(discord_id);
  CREATE INDEX IF NOT EXISTS idx_history_user ON upload_history(user_id);
  CREATE INDEX IF NOT EXISTS idx_payments_user ON payment_requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON server_logs(created_at DESC);
`);

// ── Tier config ──────────────────────────────────────────────
const TIERS = {
  free:   { name: "Free",   limit: 50,        price: 0,      color: "#888" },
  bronze: { name: "Bronze", limit: 200,       price: 50000,  color: "#cd7f32" },
  silver: { name: "Silver", limit: 500,       price: 100000, color: "#c0c0c0" },
  gold:   { name: "Gold",   limit: Infinity,  price: 180000, color: "#ffd700" },
};

// ── Helpers ──────────────────────────────────────────────────
function getUser(discordId) {
  return db.prepare("SELECT * FROM users WHERE discord_id = ?").get(discordId);
}

function upsertUser(profile) {
  const existing = getUser(profile.id);
  if (existing) {
    db.prepare(`UPDATE users SET username=?, avatar=?, last_seen=datetime('now') WHERE discord_id=?`)
      .run(profile.username, profile.avatar, profile.id);
    return getUser(profile.id);
  } else {
    db.prepare(`INSERT INTO users (discord_id, username, avatar) VALUES (?, ?, ?)`)
      .run(profile.id, profile.username, profile.avatar);
    return getUser(profile.id);
  }
}

function resetMonthlyUploads() {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  db.prepare(`UPDATE users SET uploads_used=0, reset_date=? WHERE reset_date < ?`)
    .run(currentMonth, currentMonth);
}

function getRemainingUploads(user) {
  const tier = TIERS[user.tier] || TIERS.free;
  if (tier.limit === Infinity) return Infinity;
  return Math.max(0, tier.limit - user.uploads_used);
}

function addLog(msg, type = "info", userId = null) {
  db.prepare("INSERT INTO server_logs (msg, type, user_id) VALUES (?, ?, ?)")
    .run(msg, type, userId);
  // Keep only last 500 logs
  db.prepare("DELETE FROM server_logs WHERE id NOT IN (SELECT id FROM server_logs ORDER BY id DESC LIMIT 500)").run();
}

module.exports = { db, TIERS, getUser, upsertUser, resetMonthlyUploads, getRemainingUploads, addLog };
