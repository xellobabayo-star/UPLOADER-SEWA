require("dotenv").config();
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");

const { db, TIERS, getUser, upsertUser, resetMonthlyUploads, getRemainingUploads, addLog } = require("./db");
const { requireAuth, requireAdmin } = require("./middleware/auth");
const { processAudio, uploadToRoblox } = require("./routes/audio");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Ensure data/uploads dir ──────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, "data/uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Session ──────────────────────────────────────────────────
const SQLiteStore = require("connect-sqlite3")(session);
app.use(session({
  store: new SQLiteStore({ db: "sessions.db", dir: "./data" }),
  secret: process.env.SESSION_SECRET || "pendosa-secret-change-this",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

// ── Passport Discord ─────────────────────────────────────────
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL,
  scope: ["identify"],
}, (accessToken, refreshToken, profile, done) => {
  try {
    const user = upsertUser(profile);
    addLog(`Login: ${profile.username} (${profile.id})`, "info", user.id);
    done(null, user);
  } catch (e) {
    done(e);
  }
}));

passport.serializeUser((user, done) => done(null, user.discord_id));
passport.deserializeUser((id, done) => {
  const user = getUser(id);
  done(null, user || false);
});

app.use(passport.initialize());
app.use(passport.session());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── No-cache for HTML ────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// ── Multer ───────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/") || /\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error("Hanya file audio yang diizinkan"));
    }
  },
});

// ── Reset monthly uploads cron (check tiap jam) ──────────────
resetMonthlyUploads();
setInterval(resetMonthlyUploads, 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════

app.get("/auth/discord", passport.authenticate("discord"));

app.get("/auth/discord/callback",
  passport.authenticate("discord", { failureRedirect: "/?error=auth" }),
  (req, res) => res.redirect("/dashboard")
);

app.get("/auth/logout", (req, res) => {
  req.logout(() => res.redirect("/"));
});

// ════════════════════════════════════════════════════════════
// API — USER
// ════════════════════════════════════════════════════════════

app.get("/api/me", requireAuth, (req, res) => {
  const tier = TIERS[req.user.tier] || TIERS.free;
  const remaining = getRemainingUploads(req.user);
  const adminIds = (process.env.ADMIN_DISCORD_IDS || "").split(",").map(s => s.trim());
  res.json({
    id: req.user.id,
    discord_id: req.user.discord_id,
    username: req.user.username,
    avatar: req.user.avatar,
    tier: req.user.tier,
    tierInfo: tier,
    uploads_used: req.user.uploads_used,
    remaining: remaining === Infinity ? 999999 : remaining,
    isUnlimited: tier.limit === Infinity,
    reset_date: req.user.reset_date,
    roblox_user_id: req.user.roblox_user_id,
    roblox_group_id: req.user.roblox_group_id,
    roblox_api_key: req.user.roblox_api_key ? "••••••••" : null,
    creator_type: req.user.creator_type,
    isAdmin: adminIds.includes(req.user.discord_id),
  });
});

app.post("/api/settings", requireAuth, (req, res) => {
  const { roblox_user_id, roblox_group_id, roblox_api_key, creator_type } = req.body;
  db.prepare(`UPDATE users SET roblox_user_id=?, roblox_group_id=?, roblox_api_key=?, creator_type=? WHERE id=?`)
    .run(roblox_user_id || null, roblox_group_id || null, roblox_api_key || null, creator_type || "user", req.user.id);
  res.json({ ok: true });
});

app.post("/api/validate-key", requireAuth, async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (!user.roblox_api_key) return res.json({ valid: false, error: "API Key belum disimpan" });

  const apiKey = user.roblox_api_key;
  const creatorType = user.creator_type || "user";
  const userId = user.roblox_user_id;
  const groupId = user.roblox_group_id;

  try {
    let name = "";
    if (creatorType === "group") {
      const r = await axios.get(`https://apis.roblox.com/cloud/v2/groups/${groupId}`, {
        headers: { "x-api-key": apiKey }
      });
      name = r.data.displayName || r.data.name || `Group ${groupId}`;
    } else {
      try {
        const r = await axios.get(`https://apis.roblox.com/cloud/v2/users/${userId}`, {
          headers: { "x-api-key": apiKey }
        });
        name = r.data.displayName || r.data.name || `User ${userId}`;
      } catch (e2) {
        if (e2.response?.status === 403) {
          const pub = await axios.get(`https://users.roblox.com/v1/users/${userId}`).catch(() => null);
          name = pub?.data?.displayName || `User ${userId}`;
        } else throw e2;
      }
    }
    res.json({ valid: true, name });
  } catch (e) {
    res.json({ valid: false, status: e.response?.status, error: e.response?.data || e.message });
  }
});

app.get("/api/history", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM upload_history WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(req.user.id);
  res.json(rows);
});

// ════════════════════════════════════════════════════════════
// API — UPLOAD (SSE streaming)
// ════════════════════════════════════════════════════════════

app.post("/api/upload", requireAuth, upload.array("files", 500), async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (!user.roblox_api_key) return res.status(400).json({ error: "Simpan API Key Roblox dulu di Settings" });

  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "Tidak ada file" });

  const tier = TIERS[user.tier] || TIERS.free;
  const remaining = getRemainingUploads(user);
  const isUnlimited = tier.limit === Infinity;

  if (!isUnlimited && remaining <= 0) {
    return res.status(403).json({ error: `Kuota habis! Tier ${tier.name} hanya ${tier.limit} upload/bulan. Upgrade tier untuk lanjut.` });
  }

  const filesToProcess = isUnlimited ? files : files.slice(0, remaining);
  const skipped = files.length - filesToProcess.length;

  const speed = parseFloat(req.body.speed) || 1.0;
  const pitch = parseFloat(req.body.pitch) || 0;
  const normalize = req.body.normalize !== "false";
  const displayName = req.body.displayName || "";
  const description = req.body.description || "";

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  if (skipped > 0) send({ type: "warn", msg: `${skipped} file diskip karena kuota tidak cukup` });

  let successCount = 0;

  for (let i = 0; i < filesToProcess.length; i++) {
    const file = filesToProcess[i];
    const entry = {
      user_id: user.id,
      filename: file.originalname,
      file_size: file.size,
      status: "pending",
    };

    const insertId = db.prepare(`INSERT INTO upload_history (user_id, filename, file_size, status) VALUES (?,?,?,?)`)
      .run(entry.user_id, entry.filename, entry.file_size, entry.status).lastInsertRowid;

    try {
      send({ type: "progress", index: i + 1, total: filesToProcess.length, file: file.originalname, status: "ffmpeg" });
      const processed = await processAudio(file.buffer, { speed, pitch, normalize });

      send({ type: "progress", index: i + 1, total: filesToProcess.length, file: file.originalname, status: "uploading" });
      const assetId = await uploadToRoblox(
        processed, file.originalname,
        user.roblox_api_key, user.creator_type,
        user.roblox_user_id, user.roblox_group_id,
        displayName, description
      );

      db.prepare("UPDATE upload_history SET status='SUCCESS', asset_id=? WHERE id=?").run(assetId, insertId);
      db.prepare("UPDATE users SET uploads_used=uploads_used+1 WHERE id=?").run(user.id);
      addLog(`Upload sukses: ${file.originalname} → ${assetId}`, "success", user.id);
      send({ type: "result", index: i + 1, total: filesToProcess.length, file: file.originalname, status: "SUCCESS", assetId });
      successCount++;
    } catch (e) {
      const errMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      db.prepare("UPDATE upload_history SET status='FAILED', error=? WHERE id=?").run(errMsg, insertId);
      addLog(`Upload gagal: ${file.originalname} — ${errMsg}`, "error", user.id);
      send({ type: "result", index: i + 1, total: filesToProcess.length, file: file.originalname, status: "FAILED", error: errMsg });
    }

    if (i < filesToProcess.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  send({ type: "done", success: successCount, total: filesToProcess.length });
  res.end();
});

// ════════════════════════════════════════════════════════════
// API — PAYMENT
// ════════════════════════════════════════════════════════════

const paymentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post("/api/payment/request", requireAuth, paymentUpload.single("proof"), async (req, res) => {
  const { target_tier, note } = req.body;
  if (!TIERS[target_tier]) return res.status(400).json({ error: "Tier tidak valid" });
  if (target_tier === "free") return res.status(400).json({ error: "Tidak perlu request untuk tier Free" });

  // Check pending request
  const pending = db.prepare("SELECT * FROM payment_requests WHERE user_id=? AND status='pending'").get(req.user.id);
  if (pending) return res.status(400).json({ error: "Kamu sudah punya request yang sedang menunggu review" });

  let proofFilename = null;
  let proofUrl = null;

  if (req.file) {
    proofFilename = `${uuidv4()}_${req.file.originalname}`;
    const proofPath = path.join(UPLOAD_DIR, proofFilename);
    fs.writeFileSync(proofPath, req.file.buffer);
    proofUrl = `/uploads/${proofFilename}`;
  }

  const tier = TIERS[target_tier];
  db.prepare(`INSERT INTO payment_requests (user_id, target_tier, amount, proof_url, proof_filename, note) VALUES (?,?,?,?,?,?)`)
    .run(req.user.id, target_tier, tier.price, proofUrl, proofFilename, note || null);

  addLog(`Payment request: ${req.user.username} → ${target_tier} (Rp${tier.price.toLocaleString()})`, "info", req.user.id);
  res.json({ ok: true });
});

app.get("/api/payment/my-requests", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM payment_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(req.user.id);
  res.json(rows);
});

// ════════════════════════════════════════════════════════════
// API — ADMIN
// ════════════════════════════════════════════════════════════

app.get("/api/admin/stats", requireAuth, requireAdmin, (req, res) => {
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  const totalUploads = db.prepare("SELECT COUNT(*) as c FROM upload_history WHERE status='SUCCESS'").get().c;
  const pendingPayments = db.prepare("SELECT COUNT(*) as c FROM payment_requests WHERE status='pending'").get().c;
  const tierCounts = db.prepare("SELECT tier, COUNT(*) as c FROM users GROUP BY tier").all();
  const todayUploads = db.prepare("SELECT COUNT(*) as c FROM upload_history WHERE date(created_at)=date('now') AND status='SUCCESS'").get().c;
  res.json({ totalUsers, totalUploads, pendingPayments, tierCounts, todayUploads });
});

app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const search = req.query.search || "";
  const tier = req.query.tier || "";
  let q = "SELECT * FROM users WHERE 1=1";
  const params = [];
  if (search) { q += " AND (username LIKE ? OR discord_id LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
  if (tier) { q += " AND tier=?"; params.push(tier); }
  q += " ORDER BY created_at DESC LIMIT 100";
  res.json(db.prepare(q).all(...params));
});

app.patch("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  const { tier, banned, ban_reason } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User tidak ditemukan" });

  if (tier !== undefined) {
    if (!TIERS[tier]) return res.status(400).json({ error: "Tier tidak valid" });
    db.prepare("UPDATE users SET tier=? WHERE id=?").run(tier, user.id);
    addLog(`Admin ubah tier ${user.username}: ${user.tier} → ${tier}`, "success");
  }
  if (banned !== undefined) {
    db.prepare("UPDATE users SET banned=?, ban_reason=? WHERE id=?").run(banned ? 1 : 0, ban_reason || null, user.id);
    addLog(`Admin ${banned ? "ban" : "unban"} user ${user.username}`, banned ? "warn" : "success");
  }
  res.json({ ok: true });
});

app.get("/api/admin/payments", requireAuth, requireAdmin, (req, res) => {
  const status = req.query.status || "pending";
  const rows = db.prepare(`
    SELECT pr.*, u.username, u.discord_id, u.avatar
    FROM payment_requests pr
    JOIN users u ON pr.user_id = u.id
    WHERE pr.status=?
    ORDER BY pr.created_at DESC LIMIT 50
  `).all(status);
  res.json(rows);
});

app.patch("/api/admin/payments/:id", requireAuth, requireAdmin, (req, res) => {
  const { action, note } = req.body; // action: approve | reject
  const payment = db.prepare("SELECT * FROM payment_requests WHERE id=?").get(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment tidak ditemukan" });
  if (payment.status !== "pending") return res.status(400).json({ error: "Payment sudah diproses" });

  if (action === "approve") {
    db.prepare("UPDATE payment_requests SET status='approved', reviewed_by=?, reviewed_at=datetime('now'), note=? WHERE id=?")
      .run(req.user.discord_id, note || null, payment.id);
    db.prepare("UPDATE users SET tier=? WHERE id=?").run(payment.target_tier, payment.user_id);
    addLog(`Payment APPROVED: user_id ${payment.user_id} → ${payment.target_tier}`, "success");
  } else {
    db.prepare("UPDATE payment_requests SET status='rejected', reviewed_by=?, reviewed_at=datetime('now'), note=? WHERE id=?")
      .run(req.user.discord_id, note || null, payment.id);
    addLog(`Payment REJECTED: user_id ${payment.user_id}`, "warn");
  }
  res.json({ ok: true });
});

app.get("/api/admin/logs", requireAuth, requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const rows = db.prepare("SELECT * FROM server_logs ORDER BY created_at DESC LIMIT ?").all(limit);
  res.json(rows);
});

app.delete("/api/admin/logs", requireAuth, requireAdmin, (req, res) => {
  db.prepare("DELETE FROM server_logs").run();
  res.json({ ok: true });
});

// ── Serve proof uploads ──────────────────────────────────────
app.use("/uploads", requireAuth, express.static(UPLOAD_DIR));

// ════════════════════════════════════════════════════════════
// PAGE ROUTES
// ════════════════════════════════════════════════════════════

// ── Landing page — "/" ───────────────────────────────────────
// Kalau sudah login → langsung ke /dashboard
// Kalau belum login → tampil landing.html
app.get("/", (req, res) => {
  if (req.isAuthenticated()) return res.redirect("/dashboard");
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

// ── Dashboard app — "/dashboard" ────────────────────────────
// Selalu serve index.html, auth dicek oleh init() di frontend
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Catch-all → dashboard app (untuk SPA internal routes) ───
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  addLog(`🚀 Pendosa Bypass Audio running on port ${PORT}`, "success");
  addLog(`👑 Admin IDs: ${process.env.ADMIN_DISCORD_IDS || "BELUM DISET"}`, "info");
  console.log(`Server running on port ${PORT}`);
});
