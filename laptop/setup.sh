#!/bin/bash
# HomeLab Server Node — Auto Setup Script
# Run as: bash setup.sh
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC} $*"; exit 1; }
info() { echo -e "\n${YELLOW}>>> $* ${NC}"; }

info "HomeLab Server Node Setup"
echo "Admin PC: 192.168.1.212 | This Server: 192.168.1.100 (target)"
echo ""

# ── 1. System check ──────────────────────────────────────────
info "Step 1: System Check"
uname -a
lsb_release -a 2>/dev/null || cat /etc/os-release
free -h
ip addr | grep "inet " | grep -v "127.0.0.1"
df -h | grep -E "^/dev|Filesystem"

# ── 2. Docker ────────────────────────────────────────────────
info "Step 2: Docker Installation"
if command -v docker &>/dev/null; then
    ok "Docker already installed: $(docker --version)"
else
    warn "Installing Docker..."
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    sudo systemctl enable docker
    sudo systemctl start docker
    ok "Docker installed"
fi

if docker compose version &>/dev/null; then
    ok "Docker Compose: $(docker compose version)"
else
    sudo apt-get install -y docker-compose-plugin
fi

# ── 3. Find and mount SSD ────────────────────────────────────
info "Step 3: External SSD Setup"
echo "Available block devices:"
lsblk -f
echo ""
warn "Checking /mnt/ssd..."

if mountpoint -q /mnt/ssd; then
    ok "SSD already mounted at /mnt/ssd"
else
    warn "SSD not mounted. Please mount it manually or run:"
    echo "  sudo mkdir -p /mnt/ssd"
    echo "  sudo mount /dev/sdX1 /mnt/ssd  (replace sdX1 with your device)"
    echo "  Then add to /etc/fstab for auto-mount on boot"
    read -r -p "Press Enter after mounting SSD, or Ctrl+C to exit..." _
fi

# ── 4. Create directory structure ───────────────────────────
info "Step 4: Creating Directory Structure"
dirs=(
    /mnt/ssd/docker/nextcloud/data
    /mnt/ssd/docker/nextcloud/db
    /mnt/ssd/docker/jellyfin/config
    /mnt/ssd/docker/jellyfin/cache
    /mnt/ssd/docker/adguard/work
    /mnt/ssd/docker/adguard/conf
    /mnt/ssd/docker/portainer/data
    /mnt/ssd/docker/traefik/logs
    /mnt/ssd/users/admin
    /mnt/ssd/users/shared
    /mnt/ssd/media/movies
    /mnt/ssd/media/series
    /mnt/ssd/media/music
    /mnt/ssd/media/photos
    /mnt/ssd/backups/daily
    /mnt/ssd/backups/weekly
    /mnt/ssd/backups/config
    /mnt/ssd/agent
    /mnt/ssd/logs
)
for d in "${dirs[@]}"; do
    mkdir -p "$d"
done
chown -R "$USER:$USER" /mnt/ssd
ok "Directory structure created"

# ── 5. Copy project files ────────────────────────────────────
info "Step 5: Copying Project Files"
sudo mkdir -p /opt/homelab
sudo chown "$USER:$USER" /opt/homelab

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

cp "$SCRIPT_DIR/docker-compose.yml" /opt/homelab/
cp -r "$SCRIPT_DIR/agent/"* /mnt/ssd/agent/
cp "$SCRIPT_DIR/backup.sh" /opt/homelab/
chmod +x /opt/homelab/backup.sh

# Discord bot
mkdir -p /opt/homelab/discord-bot
cp -r "$REPO_ROOT/discord-bot/." /opt/homelab/discord-bot/
ok "Files copied to /opt/homelab/"

# ── 6. Generate .env ─────────────────────────────────────────
info "Step 6: Generating .env"
if [ -f /opt/homelab/.env ]; then
    warn ".env already exists, skipping"
else
    DB_ROOT=$(openssl rand -hex 32)
    DB_PASS=$(openssl rand -hex 32)
    API_KEY=$(openssl rand -hex 64)

    read -r -p "Set Nextcloud admin password: " NC_PASS
    [ -z "$NC_PASS" ] && NC_PASS="admin$(openssl rand -hex 8)"

    cat > /opt/homelab/.env <<EOF
DB_ROOT_PASSWORD=$DB_ROOT
DB_PASSWORD=$DB_PASS
NEXTCLOUD_ADMIN_PASSWORD=$NC_PASS
AGENT_API_KEY=$API_KEY
EOF
    chmod 600 /opt/homelab/.env
    ok ".env generated"
    warn "SAVE YOUR API KEY: $API_KEY"
    warn "You'll need this in Admin Dashboard on your PC"
fi

# ── 7. SSH Setup ─────────────────────────────────────────────
info "Step 7: SSH Setup"
sudo systemctl enable ssh 2>/dev/null || sudo systemctl enable openssh-server 2>/dev/null || true
sudo systemctl start ssh 2>/dev/null || sudo systemctl start openssh-server 2>/dev/null || true
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
ok "SSH is running"
warn "On Admin PC, run: ssh-keygen -t ed25519 -f ~/.ssh/homelabkey"
warn "Then: ssh-copy-id -i ~/.ssh/homelabkey.pub $(whoami)@$(hostname -I | awk '{print $1}')"

# ── 8. Static IP hint ────────────────────────────────────────
info "Step 8: Static IP"
CURRENT_IP=$(hostname -I | awk '{print $1}')
warn "Current IP: $CURRENT_IP — Target IP: 192.168.1.100"
if [ "$CURRENT_IP" = "192.168.1.100" ]; then
    ok "Already on correct IP"
else
    warn "Set static IP 192.168.1.100 via router DHCP reservation (recommended)"
    warn "Or configure netplan/network-manager manually"
fi

# ── 9. Start Docker stack ────────────────────────────────────
info "Step 9: Starting Docker Stack"
cd /opt/homelab
docker compose up -d
ok "Docker stack started"
sleep 3
docker compose ps

# ── 10. Systemd service ──────────────────────────────────────
info "Step 10: Systemd Autostart"
sudo tee /etc/systemd/system/homelab.service > /dev/null <<EOF
[Unit]
Description=HomeLab Docker Stack
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/homelab
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
User=$USER

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable homelab
ok "Homelab service enabled"

# ── 11. Cron backup ──────────────────────────────────────────
info "Step 11: Backup Cron"
(crontab -l 2>/dev/null | grep -v backup.sh; echo "0 2 * * * /opt/homelab/backup.sh") | crontab -
ok "Backup scheduled at 02:00 daily"

# ── 12. Final status ─────────────────────────────────────────
info "Setup Complete!"
AGENT_KEY=$(grep AGENT_API_KEY /opt/homelab/.env | cut -d= -f2)
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              HOMELAB SERVER NODE — READY                 ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  Server IP:   %-42s ║\n" "$CURRENT_IP"
echo "║                                                          ║"
echo "║  Services:                                               ║"
printf "║    Nextcloud   http://%-36s ║\n" "$CURRENT_IP:8080"
printf "║    Jellyfin    http://%-36s ║\n" "$CURRENT_IP:8096"
printf "║    AdGuard     http://%-36s ║\n" "$CURRENT_IP:3001"
printf "║    Portainer   http://%-36s ║\n" "$CURRENT_IP:9000"
printf "║    Node Agent  http://%-36s ║\n" "$CURRENT_IP:9090"
echo "║                                                          ║"
echo "║  On Admin PC (Windows), edit admin-dashboard/.env:      ║"
printf "║    LAPTOP_IP=%-44s ║\n" "$CURRENT_IP"
echo "║    AGENT_API_KEY=<see above>                             ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  API Key: $AGENT_KEY"
echo ""
