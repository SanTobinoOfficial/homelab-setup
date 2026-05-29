#!/bin/bash
set -e
DATE=$(date +%Y-%m-%d)
BACKUP_DIR="/mnt/ssd/backups/daily/$DATE"
LOG="/mnt/ssd/logs/backup.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== Backup started: $DATE ==="
mkdir -p "$BACKUP_DIR"

cp /opt/homelab/docker-compose.yml "$BACKUP_DIR/"
cp /opt/homelab/.env "$BACKUP_DIR/.env.bak"

rsync -a --delete /mnt/ssd/docker/nextcloud/db/ "$BACKUP_DIR/nextcloud-db/" && log "nextcloud-db: OK"
rsync -a --delete /mnt/ssd/docker/adguard/ "$BACKUP_DIR/adguard/" && log "adguard: OK"
rsync -a --delete /mnt/ssd/docker/jellyfin/config/ "$BACKUP_DIR/jellyfin-config/" && log "jellyfin-config: OK"

find /mnt/ssd/backups/daily -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
log "=== Backup completed ==="
