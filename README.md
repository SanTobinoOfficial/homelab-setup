# 🏠 HomeLab Setup

Kompletny, dwu-maszynowy system homelab — zarządzany przez AI (Claude Code), kontrolowany przez Discord i panel admina.

---

## Architektura

```
┌─────────────────────────────────┐         ┌─────────────────────────────────────┐
│        ADMIN PC (Windows 11)    │         │      LAPTOP ASUS (Debian 12)        │
│        192.168.1.212            │◄───────►│      192.168.1.100                  │
│                                 │  SSH +  │                                     │
│  • Admin Dashboard :3000        │  API    │  • Traefik         :80 / :8090      │
│  • Claude Code (dev)            │         │  • Pi-hole         :53 / :8053      │
│  • Discord (kontrola)           │         │  • Heimdall        :8888            │
│                                 │         │  • Authelia        :9091            │
└─────────────────────────────────┘         │  • Nextcloud       :8080            │
                                            │  • Jellyfin        :8096            │
              Discord Bot ◄─────────────────│  • Portainer       :9000            │
              (z telefonu/PC)               │  • Node Agent      :9090            │
                                            │  • Discord Bot     (Docker)         │
                                            │                                     │
                                            │  External SSD 1TB → /mnt/ssd       │
                                            └─────────────────────────────────────┘
```

---

## Co dostajesz

| Funkcja | Narzędzie |
|---------|-----------|
| Pliki w chmurze (NAS) | Nextcloud |
| Media server | Jellyfin |
| DNS + blokowanie reklam | Pi-hole |
| Dashboard użytkownika | Heimdall |
| Autoryzacja (role) | Authelia |
| Zarządzanie Dockerem | Portainer |
| Reverse proxy | Traefik |
| Panel admina na PC | Custom Node.js dashboard |
| Kontrola przez Discord | Discord Bot (komendy !status, !restart, !claude) |
| Automatyczny setup | Claude Code CLI |

---

## Wymagania

### Sprzęt
- **Admin PC** — dowolny Windows 10/11 z Node.js (masz już)
- **Laptop ASUS** — min. 4GB RAM, dowolny dysk na OS + **External SSD 1TB**
- **Router** z dostępem do panelu (do zmiany DNS)

### Konta i tokeny
- Konto **Anthropic** → API key → [console.anthropic.com](https://console.anthropic.com)
- Konto **Discord** + serwer → token bota → [discord.com/developers](https://discord.com/developers/applications)
- Konto **GitHub** (do klonowania repo)

---

## KROK 1 — Zainstaluj Debian 12 na laptopie

### 1a. Pobierz ISO

[debian.org/distrib/netinst](https://www.debian.org/distrib/netinst) — wersja **amd64**, ~400MB

### 1b. Wgraj na pendrive

Użyj **Rufus** (Windows): rufus.ie → wybierz ISO → Write → Start

### 1c. Zainstaluj

1. Uruchom laptop z pendrive (klawisz boot menu: F8, F12 lub ESC — zależy od modelu ASUS)
2. Wybierz **Install** (nie graphical)
3. Ustawienia:
   - Język: English (lub polski)
   - Hostname: `homelab`
   - Root password: ustaw silne hasło
   - Utwórz użytkownika (np. `homelab`)
   - Partycjonowanie: **Guided - use entire disk**
4. Software selection — odznacz wszystko, zostaw tylko:
   - ☑ SSH server
   - ☑ Standard system utilities
   - ✗ Desktop environment — NIE instaluj
5. GRUB → zainstaluj na głównym dysku

### 1d. Po instalacji — zaloguj się przez SSH z PC

```powershell
# Na Twoim głównym PC (Windows):
ssh homelab@192.168.1.XXX   # sprawdź IP na ekranie laptopa: ip addr
```

---

## KROK 2 — Zainstaluj Claude Code na laptopie

```bash
# Na laptopie (przez SSH lub bezpośrednio):

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git curl
node --version   # powinno być v20.x

# Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Zaloguj się (API key z console.anthropic.com)
claude config set -g apiKey sk-ant-TWOJ_KLUCZ_API
```

---

## KROK 3 — Uruchom automatyczny setup przez Claude Code

```bash
# Na laptopie:
git clone https://github.com/SanTobinoOfficial/homelab-setup
cd homelab-setup
claude
```

Gdy Claude Code się uruchomi, wklej **dokładnie ten prompt**:

```
Postępuj zgodnie z instrukcjami w pliku CLAUDE_PROMPT.md znajdującym się w tym repo.
```

Claude Code przeczyta `CLAUDE_PROMPT.md` i przeprowadzi Cię przez cały setup interaktywnie:
- instalacja Dockera
- montowanie SSD
- generowanie haseł
- uruchomienie wszystkich usług
- konfiguracja backupów
- setup bota Discord

> ⚠️ Proces zajmuje ok. 15-30 minut. Claude będzie pytać o decyzje (hasła, IP, tokeny Discord).

---

## KROK 4 — Skonfiguruj Admin Dashboard na PC

Po zakończeniu setupu laptopa Claude poda Ci **API Key** i **IP laptopa**.

```powershell
# Na Twoim PC (Windows):
cd C:\homelab-setup\admin-dashboard

# Skopiuj przykładowy .env
copy .env.example .env

# Edytuj .env (notatnik lub VS Code):
# LAPTOP_IP=192.168.1.100
# AGENT_API_KEY=klucz_z_laptopa

npm install
npm start
```

Otwórz **http://localhost:3000** — widzisz panel z metrykami laptopa, usługami, logami.

---

## KROK 5 — Discord Bot

### 5a. Utwórz aplikację Discord

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Zakładka **Bot** → **Reset Token** → skopiuj token
3. W Bot settings włącz:
   - ☑ Message Content Intent
   - ☑ Server Members Intent
4. Zakładka **OAuth2** → URL Generator → scope: `bot` → permissions: `Send Messages`, `Read Messages`, `Embed Links`
5. Skopiuj wygenerowany URL → otwórz → dodaj bota do swojego serwera

### 5b. Pobierz ID kanału i swoje ID

W Discord: **Ustawienia → Zaawansowane → Tryb dewelopera: ON**
- ID kanału: prawy klik na kanał → **Kopiuj ID**
- Twoje ID: prawy klik na swoje imię → **Kopiuj ID**

### 5c. Uzupełnij .env na laptopie

Claude Code podczas setupu zapyta o te dane. Możesz też edytować ręcznie:

```bash
# Na laptopie:
nano /opt/homelab/.env
```

Uzupełnij:
```
DISCORD_TOKEN=token_z_kroku_5a
ALLOWED_CHANNEL_ID=id_kanalu
ADMIN_USER_ID=twoje_discord_id
```

Zrestartuj bota:
```bash
docker compose -f /opt/homelab/docker-compose.yml restart discord-bot
```

### Komendy Discord

| Komenda | Opis |
|---------|------|
| `!status` | Pełny status serwera (CPU, RAM, dysk, usługi) |
| `!metrics` | Metryki systemowe |
| `!services` | Lista kontenerów Docker |
| `!storage` | Informacje o dysku SSD |
| `!restart <usługa>` | Restart kontenera (np. `!restart nextcloud`) |
| `!stop <usługa>` | Zatrzymanie kontenera |
| `!logs <usługa> [n]` | Ostatnie N linii logów |
| `!run <komenda>` | Wykonaj komendę bash na laptopie |
| `!claude <prompt>` | Wyślij prompt do Claude Code CLI na laptopie |
| `!help` | Lista wszystkich komend |

**Przykład `!claude`:**
```
!claude sprawdź czy Nextcloud działa poprawnie i napraw błędy jeśli są
```

---

## KROK 6 — Skonfiguruj router

### Ustaw Pi-hole jako DNS

W panelu routera (zazwyczaj http://192.168.1.1):
- **DHCP → Primary DNS:** `192.168.1.100`
- **DHCP → Secondary DNS:** `8.8.8.8`

Od teraz wszystkie urządzenia w sieci korzystają z Pi-hole (blokowanie reklam, lokalne DNS).

### Dodaj lokalne nazwy DNS

Panel Pi-hole (http://192.168.1.100:8053/admin) → **Local DNS → DNS Records:**

| Domena | IP |
|--------|----|
| `portal.home` | `192.168.1.100` |
| `nextcloud.home` | `192.168.1.100` |
| `jellyfin.home` | `192.168.1.100` |
| `pihole.home` | `192.168.1.100` |

### Captive portal (auto-redirect po połączeniu z WiFi)

Jeśli router obsługuje captive portal (np. OpenWrt, pfSense, Mikrotik, niektóre TP-Link):
- Portal URL: `http://192.168.1.100:8888`

Bez captive portal — użytkownicy wchodzą na `http://portal.home` po ręcznym wpisaniu.

---

## Dostęp do usług

| Usługa | URL | Dane |
|--------|-----|------|
| **Admin Dashboard** | http://localhost:3000 | (na PC) |
| **Heimdall (portal)** | http://192.168.1.100:8888 | |
| **Nextcloud** | http://192.168.1.100:8080 | admin / hasło z setup |
| **Jellyfin** | http://192.168.1.100:8096 | konfiguracja przy pierwszym wejściu |
| **Pi-hole** | http://192.168.1.100:8053/admin | hasło z .env |
| **Portainer** | http://192.168.1.100:9000 | konfiguracja przy pierwszym wejściu |
| **Authelia** | http://192.168.1.100:9091 | admin / hasło z users_database.yml |
| **Traefik** | http://192.168.1.100:8090 | bez hasła (tylko LAN) |

---

## Zarządzanie rolami (Authelia)

Edytuj `/mnt/ssd/docker/authelia/users_database.yml` na laptopie:

```bash
# Na laptopie:
nano /mnt/ssd/docker/authelia/users_database.yml

# Generuj hash nowego hasła:
docker run --rm authelia/authelia:latest authelia hash-password 'nowehaslo'
```

Po edycji:
```bash
docker compose -f /opt/homelab/docker-compose.yml restart authelia
```

**Grupy:**
- `admins` → dostęp do Portainera, Traefika, Pi-hole (przez Authelia)
- `users` → dostęp do podstawowych usług

---

## Struktura folderów na SSD

```
/mnt/ssd/
├── docker/           # Dane kontenerów (wolumeny)
│   ├── nextcloud/
│   ├── jellyfin/
│   ├── pihole/
│   ├── heimdall/
│   ├── authelia/
│   ├── portainer/
│   └── traefik/
├── users/            # Dane użytkowników Nextcloud
│   ├── admin/
│   └── shared/
├── media/            # Biblioteka Jellyfin
│   ├── movies/
│   ├── series/
│   ├── music/
│   └── photos/
├── backups/          # Automatyczne backupy (codziennie 02:00)
│   ├── daily/
│   └── weekly/
├── agent/            # Node Agent API
└── logs/             # Logi systemowe
```

---

## Backup i Recovery

### Automatyczny backup

Cron uruchamia `/opt/homelab/backup.sh` codziennie o 02:00.
Backup zawiera: konfigurację Docker, bazę danych Nextcloud, konfigurację Pi-hole.
Dane użytkowników są już na SSD — są bezpieczne.

Sprawdź logi backupu:
```bash
cat /mnt/ssd/logs/backup.log
```

### Recovery — restart usługi

```bash
# Przez Discord:
!restart nextcloud

# Przez SSH:
docker compose -f /opt/homelab/docker-compose.yml restart nextcloud

# Przez Portainer:
http://192.168.1.100:9000
```

### Recovery — pełna reinstalacja laptopa

1. Zainstaluj Debian 12 od nowa
2. Podłącz SSD — dane są nienaruszone
3. Sklonuj repo i uruchom setup (`CLAUDE_PROMPT.md`)
4. Dane wracają automatycznie po podłączeniu SSD

---

## Rozwiązywanie problemów

### Port 53 zajęty (Pi-hole nie startuje)

```bash
sudo systemctl stop systemd-resolved
sudo systemctl disable systemd-resolved
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
docker compose -f /opt/homelab/docker-compose.yml restart pihole
```

### Nextcloud nie startuje

```bash
# Poczekaj 60s — baza danych potrzebuje czasu na inicjalizację
docker compose -f /opt/homelab/docker-compose.yml logs nextcloud-db --tail=20
docker compose -f /opt/homelab/docker-compose.yml logs nextcloud --tail=20
```

### SSD nie jest zamontowane

```bash
sudo mount -a
df -h /mnt/ssd
```

### Node Agent nie odpowiada (dashboard PC offline)

```bash
docker compose -f /opt/homelab/docker-compose.yml restart node-agent
curl -H "X-API-Key: KLUCZ" http://192.168.1.100:9090/api/health
```

### Discord bot nie działa

```bash
docker compose -f /opt/homelab/docker-compose.yml logs discord-bot --tail=30
# Sprawdź czy DISCORD_TOKEN jest ustawiony w /opt/homelab/.env
```

---

## Struktura repo

```
homelab-setup/
├── CLAUDE_PROMPT.md          ← Główny prompt dla Claude Code na laptopie
├── README.md                 ← Ten plik
├── admin-dashboard/          ← Panel admina (Node.js, działa na PC)
│   ├── server.js
│   ├── public/index.html
│   └── package.json
├── laptop/                   ← Pliki dla serwera (laptopa)
│   ├── docker-compose.yml    ← Definicja wszystkich usług
│   ├── .env.example          ← Szablon zmiennych środowiskowych
│   ├── setup.sh              ← Skrypt automatycznego setupu
│   ├── backup.sh             ← Skrypt backupu (cron)
│   ├── agent/
│   │   └── agent.py          ← REST API dla panelu admina
│   └── authelia/
│       ├── configuration.yml ← Konfiguracja Authelia
│       └── users_database.yml← Użytkownicy i hasła
└── discord-bot/
    ├── bot.js                ← Bot Discord
    └── package.json
```

---

## Licencja

MIT — używaj, modyfikuj, rozwijaj.
