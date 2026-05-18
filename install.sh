#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  PENDOSA BYPASS AUDIO — VPS Install Script
#  Jalankan di VPS Ubuntu 22.04/24.04 sebagai root:
#  curl -fsSL https://... | bash
#  ATAU: chmod +x install.sh && ./install.sh
# ═══════════════════════════════════════════════════════════════

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log() { echo -e "${CYAN}[PENDOSA]${NC} $1"; }
ok()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn(){ echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

log "======================================================"
log "  PENDOSA BYPASS AUDIO — VPS INSTALLER"
log "======================================================"

# Check root
[[ $EUID -ne 0 ]] && err "Jalankan sebagai root: sudo bash install.sh"

# Update system
log "Update system packages..."
apt-get update -qq && apt-get upgrade -y -qq
ok "System updated"

# Install Node.js 20 LTS
log "Install Node.js 20..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs -qq
fi
ok "Node.js $(node -v) installed"

# Install PM2
log "Install PM2..."
npm install -g pm2 -q
ok "PM2 $(pm2 -v) installed"

# Install ffmpeg
log "Install FFmpeg..."
apt-get install -y ffmpeg -qq
ok "FFmpeg $(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f3) installed"

# Install unzip
apt-get install -y unzip -qq

# Setup app directory
APP_DIR="/opt/pendosa"
log "Setup app directory: $APP_DIR"
mkdir -p $APP_DIR
ok "Directory ready"

# Check if zip exists next to script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ls $SCRIPT_DIR/*.zip 1>/dev/null 2>&1; then
  ZIP_FILE=$(ls $SCRIPT_DIR/*.zip | head -1)
  log "Found zip: $ZIP_FILE"
  unzip -o "$ZIP_FILE" -d /tmp/pendosa_extract
  cp -r /tmp/pendosa_extract/pendosa/* $APP_DIR/ 2>/dev/null || cp -r /tmp/pendosa_extract/* $APP_DIR/ 2>/dev/null
  ok "Files extracted"
fi

cd $APP_DIR

# Install npm deps
log "Install npm dependencies..."
npm install -q
ok "Dependencies installed"

# Setup .env
if [ ! -f "$APP_DIR/.env" ]; then
  log "Setup environment file..."
  cp .env.example .env
  # Generate random session secret
  SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
  sed -i "s/ganti_dengan_random_string_panjang_minimal_32_karakter/$SECRET/" .env
  warn ".env dibuat — WAJIB edit dulu sebelum start!"
  warn "  nano $APP_DIR/.env"
fi

# Create data directory
mkdir -p $APP_DIR/data/uploads
chmod 755 $APP_DIR/data

# Setup PM2
log "Setup PM2 service..."
pm2 delete pendosa 2>/dev/null || true
pm2 start $APP_DIR/server.js --name pendosa --restart-delay=3000 --max-restarts=10
pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || true
ok "PM2 service started"

# Summary
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  PENDOSA BYPASS AUDIO — INSTALLED!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  App dir  : ${CYAN}$APP_DIR${NC}"
echo -e "  Config   : ${YELLOW}nano $APP_DIR/.env${NC}"
echo -e "  Status   : ${CYAN}pm2 status${NC}"
echo -e "  Logs     : ${CYAN}pm2 logs pendosa${NC}"
echo -e "  Restart  : ${CYAN}pm2 restart pendosa${NC}"
echo ""
echo -e "${YELLOW}  LANGKAH BERIKUTNYA:${NC}"
echo -e "  1. Edit .env: ${CYAN}nano $APP_DIR/.env${NC}"
echo -e "  2. Isi DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET"
echo -e "  3. Isi DISCORD_CALLBACK_URL=http://IP_VPS:3000/auth/discord/callback"
echo -e "  4. Isi ADMIN_DISCORD_IDS=your_discord_id"
echo -e "  5. Restart: ${CYAN}pm2 restart pendosa${NC}"
echo -e "  6. Buka: ${CYAN}http://$(curl -s ifconfig.me 2>/dev/null || echo 'IP_VPS'):3000${NC}"
echo ""
