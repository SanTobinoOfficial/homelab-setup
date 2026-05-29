# HOMELAB SERVER NODE — CLAUDE CODE MAIN PROMPT
# Laptop ASUS — Pełna instrukcja konfiguracji
# Wersja: 1.0 | Admin PC: DESKTOP-PC-TOBI (192.168.1.212, Windows 11)

---

## WYMAGANY OS NA LAPTOPIE

**Rekomendowany: Debian 12 "Bookworm" Server (bez GUI)**
Alternatywnie: Ubuntu Server 22.04 LTS lub 24.04 LTS

**Dlaczego Debian 12:**
- Najlżejszy z głównych distro (mniej RAM na OS = więcej dla Dockera)
- Bardzo stabilny — idealny do 24/7
- Wsparcie do 2028 (LTS)
- Doskonała kompatybilność z Dockerem
- Brak zbędnych pakietów przy instalacji Server edition

**Instalacja Debian 12:**
1. Pobierz ISO: https://www.debian.org/distrib/netinst (netinstall ~400MB)
2. Wgraj na pendrive: Rufus (Windows) lub `dd` (Linux)
3. Podczas instalacji:
   - Wybierz: **"Standard system utilities"** — NIE instaluj GUI/Desktop
   - Ustaw hostname: `homelab`
   - Utwórz usera (np. `homelab` lub swoje imię)
4. Po instalacji — sklonuj repo i uruchom mnie (CLAUDE_PROMPT.md)

**Jeśli już masz Ubuntu/inny Linux** — też działa, KROK 1 wykryje system automatycznie.

---

## TWOJA ROLA

Jesteś Claude Code uruchomionym na **LAPTOPIE ASUS** — jest to **SERVER NODE** w systemie homelab.

Twoje zadanie: skonfigurować ten laptop od zera jako kompletny serwer działający 24/7.
Admin PC (DESKTOP-PC-TOBI, 192.168.1.212) będzie zarządzać tym laptopem przez SSH i REST API.

**NIE pytaj o pozwolenie przy każdym kroku.** Wykonuj kolejne kroki automatycznie.
**Przy błędzie** — opisz problem, zaproponuj rozwiązanie, i kontynuuj jeśli możesz.

---

## KROK 1 — ANALIZA SYSTEMU

Uruchom poniższe komendy i pokaż mi wyniki WSZYSTKICH:

```bash
uname -a
lsb_release -a 2>/dev/null || cat /etc/os-release
whoami
hostname -I
free -h
df -h
lsblk -f
cat /proc/cpuinfo | grep "model name" | head -1
nproc
docker --version 2>/dev/null || echo "Docker: NIE ZAINSTALOWANY"
python3 --version 2>/dev/null || echo "Python3: NIE ZAINSTALOWANY"
git --version 2>/dev/null || echo "Git: NIE ZAINSTALOWANY"
systemctl is-active ssh 2>/dev/null || echo "SSH: nieznany status"
```

Na podstawie wyników dostosuj kolejne kroki do rzeczywistego systemu.
**Jeśli OS nie jest Ubuntu/Debian — powiedz mi, a dopasuję instrukcje.**

---

## KROK 2 — AKTUALIZACJA SYSTEMU

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl wget git nano htop lsof net-tools openssh-server rsync openssl cron
```

Upewnij się że SSH działa:
```bash
sudo systemctl enable ssh
sudo systemctl start ssh
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
echo "SSH OK — IP: $(hostname -I | awk '{print $1}')"
```

---

## KROK 3 — DOCKER

Jeśli Docker nie jest zainstalowany:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
sudo systemctl enable docker
sudo systemctl start docker
sudo apt-get install -y docker-compose-plugin
newgrp docker
```

Weryfikacja:
```bash
docker --version
docker compose version
docker run --rm hello-world
```

---

## KROK 4 — EXTERNAL SSD

### 4a. Identyfikacja dysku

```bash
lsblk -f
fdisk -l 2>/dev/null | grep -E "^Disk /dev"
```

Szukaj dysku ~1TB (zewnętrzny SSD). Typowe nazwy: `/dev/sdb`, `/dev/sdc`, `/dev/sda` (jeśli laptopowy dysk to nvme).

### 4b. Formatowanie (tylko jeśli SSD jest pusty lub akceptujesz utratę danych)

**ZAPYTAJ MNIE PRZED WYKONANIEM jeśli nie jesteś pewny który dysk to SSD.**

```bash
# Zamień sdX na właściwy dysk:
sudo mkfs.ext4 -L homelab-ssd /dev/sdX1
```

Jeśli SSD ma już partycję ext4 — pomiń formatowanie.

### 4c. Montowanie na stałe

```bash
sudo mkdir -p /mnt/ssd

# Pobierz UUID dysku
SSD_UUID=$(sudo blkid /dev/sdX1 -s UUID -o value)
echo "UUID: $SSD_UUID"

# Dodaj do fstab
echo "UUID=$SSD_UUID /mnt/ssd ext4 defaults,nofail,x-systemd.device-timeout=30 0 2" | sudo tee -a /etc/fstab

# Zamontuj
sudo mount -a
df -h /mnt/ssd
```

---

## KROK 5 — KLONOWANIE REPO

```bash
cd ~
git clone https://github.com/SanTobinoOfficial/homelab-setup.git
cd homelab-setup
ls -la
```

---

## KROK 6 — STRUKTURA FOLDERÓW

```bash
sudo mkdir -p /opt/homelab
sudo chown "$USER:$USER" /opt/homelab

mkdir -p /mnt/ssd/docker/nextcloud/{data,db}
mkdir -p /mnt/ssd/docker/jellyfin/{config,cache}
mkdir -p /mnt/ssd/docker/adguard/{work,conf}
mkdir -p /mnt/ssd/docker/portainer/data
mkdir -p /mnt/ssd/docker/traefik/logs
mkdir -p /mnt/ssd/users/{admin,shared}
mkdir -p /mnt/ssd/media/{movies,series,music,photos}
mkdir -p /mnt/ssd/backups/{daily,weekly,config}
mkdir -p /mnt/ssd/agent
mkdir -p /mnt/ssd/logs

chown -R "$USER:$USER" /mnt/ssd
chmod -R 755 /mnt/ssd

echo "Struktura folderów OK"
ls -la /mnt/ssd/
```

---

## KROK 7 — KOPIOWANIE PLIKÓW PROJEKTU

```bash
REPO=~/homelab-setup

# Docker stack
cp "$REPO/laptop/docker-compose.yml" /opt/homelab/

# Node Agent
cp "$REPO/laptop/agent/agent.py" /mnt/ssd/agent/

# Backup script
cp "$REPO/laptop/backup.sh" /opt/homelab/
chmod +x /opt/homelab/backup.sh

echo "Pliki skopiowane"
ls /opt/homelab/
ls /mnt/ssd/agent/
```

---

## KROK 8 — GENEROWANIE KONFIGURACJI (.env)

```bash
DB_ROOT=$(openssl rand -hex 32)
DB_PASS=$(openssl rand -hex 32)
API_KEY=$(openssl rand -hex 64)

echo "Podaj hasło administratora Nextcloud (lub wciśnij Enter dla losowego):"
read -r NC_PASS
[ -z "$NC_PASS" ] && NC_PASS="admin$(openssl rand -hex 8)"

cat > /opt/homelab/.env <<EOF
DB_ROOT_PASSWORD=$DB_ROOT
DB_PASSWORD=$DB_PASS
NEXTCLOUD_ADMIN_PASSWORD=$NC_PASS
AGENT_API_KEY=$API_KEY
EOF

chmod 600 /opt/homelab/.env
echo ""
echo "=== ZAPISZ PONIŻSZE DANE ==="
echo "Nextcloud admin hasło: $NC_PASS"
echo "Agent API Key:         $API_KEY"
echo "==========================="
echo "Wklej API Key do: admin-dashboard/.env i discord-bot/.env na Admin PC"
```

---

## KROK 9 — URUCHOMIENIE DOCKER STACK

```bash
cd /opt/homelab
docker compose up -d

# Poczekaj na start
sleep 5
docker compose ps
```

Jeśli któryś kontener nie wystartuje — sprawdź logi:
```bash
docker compose logs --tail=30 <nazwa_kontenera>
```

Typowe problemy:
- **nextcloud** czeka na DB — normalnie, odczekaj 30s i sprawdź ponownie
- **adguard** konflikt port 53 — `sudo systemctl stop systemd-resolved && sudo systemctl disable systemd-resolved`
- **Port zajęty** — `ss -tlnp | grep <port>`

---

## KROK 10 — TEST NODE AGENT

```bash
# Zainstaluj curl jeśli brak
which curl || sudo apt-get install -y curl

# Pobierz API key
API_KEY=$(grep AGENT_API_KEY /opt/homelab/.env | cut -d= -f2)

# Poczekaj aż agent się uruchomi
sleep 10

# Test
curl -s -H "X-API-Key: $API_KEY" http://localhost:9090/api/health | python3 -m json.tool
curl -s -H "X-API-Key: $API_KEY" http://localhost:9090/api/metrics | python3 -m json.tool
curl -s -H "X-API-Key: $API_KEY" http://localhost:9090/api/services | python3 -m json.tool
```

---

## KROK 11 — STATYCZNY IP (przez router — ZALECANE)

Najłatwiejsza metoda: zarezerwuj IP **192.168.1.100** dla MAC adresu tego laptopa w panelu routera.

MAC adres:
```bash
ip link show | grep -A1 "state UP" | grep "link/ether" | awk '{print $2}'
```

Alternatywnie przez netplan (Ubuntu 20.04+):
```bash
INTERFACE=$(ip route | grep default | awk '{print $5}')
echo "Interfejs: $INTERFACE"

sudo tee /etc/netplan/99-homelab-static.yaml > /dev/null <<EOF
network:
  version: 2
  ethernets:
    $INTERFACE:
      dhcp4: no
      addresses: [192.168.1.100/24]
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
EOF

sudo netplan try
```

**Jeśli nie jesteś pewny — użyj metody router (bezpieczniejsza), i tylko powiedz mi adres IP.**

---

## KROK 12 — SYSTEMD AUTOSTART

```bash
cat > /tmp/homelab.service <<EOF
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

sudo mv /tmp/homelab.service /etc/systemd/system/homelab.service
sudo systemctl daemon-reload
sudo systemctl enable homelab
echo "Autostart skonfigurowany"
```

---

## KROK 13 — CRON BACKUP

```bash
(crontab -l 2>/dev/null | grep -v backup.sh
 echo "0 2 * * * /opt/homelab/backup.sh >> /mnt/ssd/logs/backup.log 2>&1"
) | crontab -

# Sprawdź
crontab -l | grep backup
echo "Backup cron: OK (codziennie 02:00)"
```

---

## KROK 14 — DISCORD BOT (hostowany na laptopie w Docker)

Bot Discord działa jako kontener Docker na tym laptopie — startuje razem z resztą stacku i restartuje się automatycznie.
Pozwala kontrolować serwer i wysyłać prompty do Claude Code CLI **z Discorda, z telefonu lub PC**.

### 14a. Skopiuj pliki bota

```bash
mkdir -p /opt/homelab/discord-bot
cp -r ~/homelab-setup/discord-bot/. /opt/homelab/discord-bot/
ls /opt/homelab/discord-bot/
```

### 14b. Uzupełnij dane Discord w /opt/homelab/.env

Potrzebujesz 3 wartości z Discorda. Otwórz panel i je zdobądź, potem uruchom:

```bash
nano /opt/homelab/.env
```

Dodaj na końcu pliku (lub uzupełnij istniejące linie):

```
DISCORD_TOKEN=TWOJ_TOKEN_BOTA
ALLOWED_CHANNEL_ID=ID_KANALU
ADMIN_USER_ID=TWOJE_DISCORD_ID
```

**Jak zdobyć wartości:**
- `DISCORD_TOKEN` → discordapp.com/developers/applications → New Application → Bot → Reset Token
- `ALLOWED_CHANNEL_ID` → Discord: Ustawienia → Zaawansowane → Tryb dewelopera ON → prawy klik kanał → Kopiuj ID
- `ADMIN_USER_ID` → prawy klik na siebie w Discordzie → Kopiuj ID

**Uprawnienia bota na Discordzie:**
W panelu Developer Portal → Bot → zaznacz:
- `Message Content Intent` (wymagane!)
- `Server Members Intent`

Zaproś bota na swój serwer:
`https://discord.com/oauth2/authorize?client_id=TWOJE_APPLICATION_ID&scope=bot&permissions=274877991936`
(zastąp `TWOJE_APPLICATION_ID` swoim Application ID z panelu)

### 14c. Uruchom bota (jako część Docker stack)

Bot jest już zdefiniowany w docker-compose.yml jako usługa `discord-bot`.
Wystarczy:

```bash
cd /opt/homelab
docker compose up -d discord-bot
docker compose logs discord-bot --tail=30
```

Jeśli zobaczysz `HomeLab Discord Bot` i `Logged in as: NazwaBota#1234` — działa.

### 14d. Sprawdź czy claude CLI jest dostępny dla bota

Bot montuje `/usr/local/bin/claude` z hosta. Sprawdź czy claude jest zainstalowany:

```bash
which claude || echo "Claude CLI: nie zainstalowany"
claude --version 2>/dev/null || echo "Zainstaluj: npm install -g @anthropic-ai/claude-code"
```

Jeśli nie ma — zainstaluj:
```bash
npm install -g @anthropic-ai/claude-code
# Zaloguj się:
claude auth login
```

Następnie zrestartuj bota żeby załadował nową ścieżkę:
```bash
docker compose restart discord-bot
```

### Dostępne komendy Discord

| Komenda | Opis |
|---------|------|
| `!status` | Pełny status serwera (embed) |
| `!metrics` | CPU, RAM, temp, uptime |
| `!services` | Lista kontenerów Docker |
| `!storage` | Informacje o dysku |
| `!restart <usługa>` | Restart kontenera |
| `!stop <usługa>` | Zatrzymanie kontenera |
| `!logs <usługa> [n]` | Ostatnie N linii logów |
| `!run <komenda>` | Wykonaj komendę bash na laptopie |
| `!claude <prompt>` | **Wyślij prompt do Claude Code CLI!** |
| `!help` | Lista komend |

### Jak działa `!claude`

Gdy napiszesz na Discordzie `!claude sprawdź czy nextcloud działa i napraw problemy`, bot:
1. Uruchamia `claude --print "sprawdź czy nextcloud działa..."` wewnątrz kontenera
2. Claude Code (zamontowany z hosta) wykonuje diagnostykę
3. Bot odsyła odpowiedź na Discord (do 2000 znaków, dłuższe odpowiedzi dzielone na części)

---

## KROK 15 — PORTAL UŻYTKOWNIKA (Pi-hole + Heimdall + Authelia)

System oparty wyłącznie na gotowych narzędziach:

```
Urządzenie łączy się z WiFi
        ↓
Router ustawia DNS → Pi-hole (192.168.1.100)
        ↓
Pi-hole przypisuje urządzenie do grupy po MAC → inne reguły blokowania
        ↓
Router captive portal → Heimdall (http://192.168.1.100:8888)
        ↓
Wrażliwe usługi (Portainer, Traefik) chronione przez Authelia (login/hasło + grupy)
```

---

### 15a. Pi-hole — DNS + DHCP + profile per-klient

Pi-hole uruchomił się już w KROK 9. Otwórz panel:
`http://192.168.1.100:8053/admin`

**Ustaw Pi-hole jako DNS w routerze:**
1. Panel routera (zwykle 192.168.1.1)
2. DHCP → Primary DNS → `192.168.1.100`
3. Secondary DNS → `8.8.8.8`

**Dodaj DNS rekordy dla lokalnych nazw:**
Panel Pi-hole → Local DNS → DNS Records:
```
portal.home     → 192.168.1.100
heimdall.home   → 192.168.1.100
nextcloud.home  → 192.168.1.100
jellyfin.home   → 192.168.1.100
```

**Przypisywanie urządzeń do grup (per MAC):**
1. Panel Pi-hole → Clients → Add client → wpisz MAC urządzenia
2. Group Management → Groups → przypisz klienta do grupy (admin/user/guest)
3. Każda grupa może mieć inne listy blokowania

**Pi-hole DHCP (opcjonalne — jeśli chcesz statyczne IP po MAC):**
Panel Pi-hole → Settings → DHCP → włącz DHCP server
Dodaj Static leases: MAC → IP (np. telefon Marka → 192.168.1.101)

---

### 15b. Heimdall — dashboard użytkownika

Heimdall to gotowy panel aplikacji — każdy widzi linki do usług, do których ma dostęp.
Otwórz: `http://192.168.1.100:8888`

**Dodaj aplikacje w Heimdall (przez UI):**
- Nextcloud: `http://192.168.1.100:8080`
- Jellyfin: `http://192.168.1.100:8096`
- Portainer: `http://192.168.1.100:9000` (tylko dla admina — chroniony przez Authelia)
- Pi-hole: `http://192.168.1.100:8053/admin`

**Captive portal — auto-redirect po połączeniu z WiFi:**

W panelu routera:
- Szukaj: "Captive Portal" / "Guest Network Portal" / "Walled Garden"
- Ustaw portal URL: `http://192.168.1.100:8888`

Jeśli router nie ma captive portal — wystarczy ustawić Pi-hole jako DNS.
Użytkownicy mogą wejść na `http://portal.home` lub `http://heimdall.home`.

---

### 15c. Authelia — logowanie i role (admin/user/guest)

Authelia chroni wrażliwe usługi przed nieautoryzowanym dostępem przez Traefik.

**Konfiguracja Authelia — szablony są już w repo:**

```bash
mkdir -p /mnt/ssd/docker/authelia

# Skopiuj szablony z repo (jeśli setup.sh nie zrobił tego automatycznie)
cp ~/homelab-setup/laptop/authelia/configuration.yml /mnt/ssd/docker/authelia/
cp ~/homelab-setup/laptop/authelia/users_database.yml /mnt/ssd/docker/authelia/
```

Edytuj `/mnt/ssd/docker/authelia/configuration.yml`:
- Zastąp `CHANGE_ME_JWT_SECRET_32_CHARS` → `$(openssl rand -hex 32)`
- Zastąp `CHANGE_ME_SESSION_SECRET_32_CHARS` → `$(openssl rand -hex 32)`
- Ustaw `default_redirection_url` na IP laptopa jeśli inne niż 192.168.1.100

Przykład pliku `/mnt/ssd/docker/authelia/configuration.yml`:

```yaml
theme: dark
jwt_secret: ZMIEŃ_NA_LOSOWY_STRING_32_ZNAKI

default_redirection_url: http://heimdall.home

server:
  host: 0.0.0.0
  port: 9091

log:
  level: info

totp:
  issuer: homelab.local

authentication_backend:
  file:
    path: /config/users_database.yml
    password:
      algorithm: bcrypt

access_control:
  default_policy: deny
  rules:
    - domain: "portainer.homelab.local"
      policy: one_factor
      subject: "group:admins"
    - domain: "heimdall.homelab.local"
      policy: bypass
    - domain: "jellyfin.homelab.local"
      policy: bypass
    - domain: "nextcloud.homelab.local"
      policy: bypass

session:
  name: authelia_session
  secret: ZMIEŃ_NA_LOSOWY_STRING_32_ZNAKI
  expiration: 3600
  inactivity: 300
  domain: homelab.local

storage:
  local:
    path: /config/db.sqlite3

notifier:
  filesystem:
    filename: /config/notification.txt
```

Utwórz `/mnt/ssd/docker/authelia/users_database.yml`:

```yaml
users:
  admin:
    displayname: "Administrator"
    # Generuj hash: docker run authelia/authelia:latest authelia hash-password 'twoje_haslo'
    password: "$6$HASH_TUTAJ"
    email: admin@homelab.local
    groups:
      - admins
      - users

  marek:
    displayname: "Marek"
    password: "$6$HASH_TUTAJ"
    email: marek@homelab.local
    groups:
      - users
```

Generuj hasła:
```bash
docker run --rm authelia/authelia:latest authelia hash-password 'twoje_haslo'
# Skopiuj wynik do users_database.yml
```

Uruchom Authelia:
```bash
cd /opt/homelab
docker compose up -d authelia
docker compose logs authelia --tail=20
```

Panel Authelia: `http://192.168.1.100:9091`

---

### Podsumowanie systemu ról

| Narzędzie | Co robi |
|-----------|---------|
| **Pi-hole** | DNS po MAC → różne profile blokowania reklam per urządzenie |
| **Pi-hole DHCP** | Statyczne IP po MAC → łatwa identyfikacja urządzeń |
| **Heimdall** | Dashboard z linkami do usług (jeden dla wszystkich) |
| **Authelia** | Login + grupy → kontrola dostępu do wrażliwych usług |
| **Router captive portal** | Auto-redirect na Heimdall po połączeniu z WiFi |

---

## KROK 17 — WERYFIKACJA KOŃCOWA

```bash
echo "=== STATUS KOŃCOWY ==="
echo ""
echo "--- Docker ---"
docker compose -f /opt/homelab/docker-compose.yml ps
echo ""
echo "--- Node Agent ---"
API_KEY=$(grep AGENT_API_KEY /opt/homelab/.env | cut -d= -f2)
curl -s -H "X-API-Key: $API_KEY" http://localhost:9090/api/health
echo ""
echo "--- Porty ---"
ss -tlnp | grep -E ':80|:8080|:8096|:3001|:9000|:9090|:22'
echo ""
echo "--- Dysk ---"
df -h /mnt/ssd
echo ""
echo "--- Autostart ---"
systemctl is-enabled homelab 2>/dev/null && echo "homelab: enabled" || echo "homelab: disabled"
echo ""
echo "=== DOSTĘP DO USŁUG ==="
IP=$(hostname -I | awk '{print $1}')
echo "Nextcloud:  http://$IP:8080"
echo "Jellyfin:   http://$IP:8096"
echo "AdGuard:    http://$IP:3001"
echo "Portainer:  http://$IP:9000"
echo "Traefik:    http://$IP:8090"
echo "Node Agent: http://$IP:9090"
echo ""
echo "=== NA ADMIN PC (Windows) ==="
echo "1. Przejdź do C:\\homelab-setup\\admin-dashboard\\"
echo "2. Skopiuj .env.example → .env"
echo "3. Ustaw LAPTOP_IP=$IP"
echo "4. Ustaw AGENT_API_KEY=$(grep AGENT_API_KEY /opt/homelab/.env | cut -d= -f2 | head -c 16)..."
echo "5. npm install && npm start"
echo "6. Otwórz http://localhost:3000"
```

---

## ROZWIĄZYWANIE PROBLEMÓW

### Port 53 zajęty (AdGuard)
```bash
sudo systemctl stop systemd-resolved
sudo systemctl disable systemd-resolved
sudo rm /etc/resolv.conf
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
docker compose restart adguard
```

### Nextcloud nie startuje
```bash
docker compose logs nextcloud-db --tail=20
docker compose logs nextcloud --tail=20
# Odczekaj 60s po pierwszym uruchomieniu — DB musi się zainicjalizować
```

### Node Agent nie odpowiada
```bash
docker compose logs node-agent --tail=30
# Sprawdź czy plik agent.py istnieje:
ls /mnt/ssd/agent/
# Ręczne uruchomienie testowe:
docker compose restart node-agent
```

### SSD nie jest zamontowane
```bash
sudo mount -a
journalctl -u systemd-fstab-generator --no-pager | tail -10
```

### Brak miejsca na dysku systemowym
```bash
df -h /
docker system prune -f  # Usuń nieużywane obrazy/kontenery
```

---

## PO ZAKOŃCZENIU POWIEDZ MI

Kiedy wszystko będzie gotowe, podsumuj:
1. IP serwera
2. Które usługi działają (docker compose ps)
3. Czy Node Agent odpowiada
4. Agent API Key (pierwsze 16 znaków)
5. Czy bot Discord działa

Ja (na Admin PC) skonfiguruje dashboard i po wpisaniu API key będę miał pełną kontrolę.

---

*Repo: https://github.com/SanTobinoOfficial/homelab-setup*
*Admin PC: DESKTOP-PC-TOBI | 192.168.1.212 | Windows 11 | Node.js v24*
