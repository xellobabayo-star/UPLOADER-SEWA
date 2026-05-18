const { db } = require("../db");

function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) {
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.status(401).json({ error: "Login dulu via Discord" });
    }
    return res.redirect("/");
  }
  // Refresh user from DB
  const user = db.prepare("SELECT * FROM users WHERE discord_id = ?").get(req.user.discord_id);
  if (!user) return res.redirect("/auth/logout");
  if (user.banned) {
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.status(403).json({ error: `Akun kamu dibanned: ${user.ban_reason || "Tidak ada alasan"}` });
    }
    req.session.destroy();
    return res.redirect("/?banned=1");
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: "Unauthorized" });
  const adminIds = (process.env.ADMIN_DISCORD_IDS || "").split(",").map(s => s.trim());
  if (!adminIds.includes(req.user.discord_id)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
