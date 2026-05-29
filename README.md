# HomeLab Setup

Dwu-maszynowy system homelab: Admin PC (Windows 11) + Laptop ASUS (serwer Linux 24/7).

## Struktura repo

```
homelab-setup/
├── CLAUDE_PROMPT.md          ← GŁÓWNY PROMPT dla Claude Code na laptopie
├── admin-dashboard/          ← Dashboard admina (Node.js, działa na Admin PC)
├── laptop/                   ← Pliki konfiguracyjne serwera
│   ├── docker-compose.yml
│   ├── setup.sh
│   └── agent/agent.py
└── discord-bot/              ← Bot Discord do kontroli serwera
```

## Szybki start

### Laptop ASUS (Server Node)

Daj Claude Code na laptopie ten prompt:

```
Sklonuj repo https://github.com/SanTobinoOfficial/homelab-setup
i postępuj zgodnie z instrukcjami w pliku CLAUDE_PROMPT.md
```

### Admin PC (Windows)

```powershell
cd C:\homelab-setup\admin-dashboard
copy .env.example .env
# Edytuj .env: ustaw LAPTOP_IP i AGENT_API_KEY
npm install
npm start
# Otwórz http://localhost:3000
```

## Usługi na laptopie

| Usługa | Port | Opis |
|--------|------|------|
| Nextcloud | :8080 | Cloud/NAS |
| Jellyfin | :8096 | Media |
| AdGuard | :3001 | DNS |
| Portainer | :9000 | Docker UI |
| Node Agent | :9090 | API dla dashboardu |

## Discord Bot

Kontroluj serwer przez Discord: `!status`, `!restart <usługa>`, `!claude <prompt>`
