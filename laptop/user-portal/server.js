require("dotenv").config({ path: "/opt/homelab/.env" });
const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const app = express();
const PORT = 8888;
const DEVICES_FILE = "/mnt/ssd/portal/devices.json";
const LAPTOP_IP = process.env.LAPTOP_IP || "192.168.1.100";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── DB helpers ────────────────────────────────────────────────────────────────
function loadDevices() {
  try {
    return JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8"));
  } catch {
    return { devices: [] };
  }
}

function saveDevices(data) {
  fs.mkdirSync(path.dirname(DEVICES_FILE), { recursive: true });
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(data, null, 2));
}

function getMacByIp(ip) {
  try {
    const result = execSync(`ip neigh show ${ip}`, { timeout: 2000 }).toString();
    const match = result.match(/lladdr\s+([\da-f:]+)/i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function findDevice(mac) {
  if (!mac) return null;
  const db = loadDevices();
  return db.devices.find(d => d.mac?.toLowerCase() === mac.toLowerCase()) || null;
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket.remoteAddress?.replace("::ffff:", "") ||
    "unknown"
  );
}

// ── Role configs ──────────────────────────────────────────────────────────────
const ROLE_CONFIG = {
  admin: {
    label: "Administrator",
    color: "#6366f1",
    badge: "bg-indigo-900 text-indigo-200",
    services: [
      { name: "Admin Dashboard", url: "http://192.168.1.212:3000", icon: "🖥️", desc: "Pełny panel administracyjny" },
      { name: "Portainer", url: `http://${LAPTOP_IP}:9000`, icon: "🐳", desc: "Zarządzanie Dockerem" },
      { name: "Nextcloud", url: `http://${LAPTOP_IP}:8080`, icon: "☁️", desc: "Pliki i chmura" },
      { name: "Jellyfin", url: `http://${LAPTOP_IP}:8096`, icon: "🎬", desc: "Media server" },
      { name: "AdGuard", url: `http://${LAPTOP_IP}:3001`, icon: "🛡️", desc: "DNS / blokowanie reklam" },
      { name: "Traefik", url: `http://${LAPTOP_IP}:8090`, icon: "↔️", desc: "Reverse proxy" },
    ],
  },
  user: {
    label: "Użytkownik",
    color: "#10b981",
    badge: "bg-emerald-900 text-emerald-200",
    services: [
      { name: "Nextcloud", url: `http://${LAPTOP_IP}:8080`, icon: "☁️", desc: "Twoje pliki w chmurze" },
      { name: "Jellyfin", url: `http://${LAPTOP_IP}:8096`, icon: "🎬", desc: "Filmy i muzyka" },
    ],
  },
  guest: {
    label: "Gość",
    color: "#f59e0b",
    badge: "bg-amber-900 text-amber-200",
    services: [
      { name: "Jellyfin", url: `http://${LAPTOP_IP}:8096`, icon: "🎬", desc: "Media (tylko podgląd)" },
    ],
  },
};

// ── HTML renderer ─────────────────────────────────────────────────────────────
function renderPortal(device, ip, mac) {
  const role = device?.role || "guest";
  const cfg = ROLE_CONFIG[role] || ROLE_CONFIG.guest;
  const name = device?.name || "Gość";

  const serviceCards = cfg.services.map(s => `
    <a href="${s.url}" target="_blank"
       class="block p-4 rounded-xl border border-gray-700 hover:border-gray-500 bg-gray-800/50 hover:bg-gray-800 transition-all group">
      <div class="text-2xl mb-2">${s.icon}</div>
      <div class="font-semibold text-white group-hover:text-indigo-300 transition">${s.name}</div>
      <div class="text-xs text-gray-400 mt-1">${s.desc}</div>
    </a>
  `).join("");

  const registerSection = !device ? `
    <div class="mt-8 p-6 rounded-xl border border-amber-700/50 bg-amber-900/20">
      <h3 class="font-semibold text-amber-300 mb-3">🆕 Nieznane urządzenie</h3>
      <p class="text-gray-400 text-sm mb-4">Twoje urządzenie nie ma przypisanej roli. Możesz poprosić administratora o dostęp lub zarejestrować się jako gość.</p>
      <form method="POST" action="/register" class="flex gap-3">
        <input type="hidden" name="mac" value="${mac || ""}">
        <input type="hidden" name="ip" value="${ip}">
        <input name="name" placeholder="Twoje imię lub nazwa urządzenia"
               class="flex-1 px-3 py-2 rounded-lg bg-gray-800 border border-gray-600 text-white text-sm focus:outline-none focus:border-amber-500">
        <button type="submit"
                class="px-4 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg text-white text-sm font-medium transition">
          Zarejestruj jako gość
        </button>
      </form>
    </div>
  ` : "";

  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HomeLab — ${name}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background: #0f1117; font-family: system-ui, sans-serif; }
    .card { background: #1a1d27; border: 1px solid #2a2d3a; }
  </style>
</head>
<body class="text-gray-100 min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-2xl">

    <!-- Header -->
    <div class="text-center mb-8">
      <div class="w-16 h-16 rounded-2xl bg-indigo-600 flex items-center justify-center text-2xl mx-auto mb-4">🏠</div>
      <h1 class="text-2xl font-bold">Witaj, <span style="color:${cfg.color}">${name}</span></h1>
      <div class="mt-2 flex items-center justify-center gap-2">
        <span class="text-xs px-3 py-1 rounded-full ${cfg.badge}">${cfg.label}</span>
        <span class="text-xs text-gray-500">${ip}</span>
      </div>
    </div>

    <!-- Services -->
    <div class="card rounded-2xl p-6">
      <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Twoje usługi</h2>
      ${cfg.services.length > 0
        ? `<div class="grid grid-cols-2 gap-3">${serviceCards}</div>`
        : '<p class="text-gray-500 text-sm text-center py-4">Brak dostępnych usług dla tej roli.</p>'
      }
    </div>

    ${registerSection}

    <!-- Footer -->
    <div class="text-center mt-6 text-xs text-gray-600">
      HomeLab Server Node &bull; ${new Date().toLocaleDateString("pl-PL")}
      ${mac ? `&bull; MAC: ${mac}` : ""}
    </div>
  </div>
</body>
</html>`;
}

function renderAdminPanel() {
  const db = loadDevices();
  const rows = db.devices.map(d => `
    <tr class="border-b border-gray-800">
      <td class="py-3 px-4 text-sm">${d.name || "—"}</td>
      <td class="py-3 px-4 text-xs font-mono text-gray-400">${d.mac}</td>
      <td class="py-3 px-4">
        <span class="text-xs px-2 py-0.5 rounded-full ${
          d.role === "admin" ? "bg-indigo-900 text-indigo-300" :
          d.role === "user" ? "bg-emerald-900 text-emerald-300" :
          "bg-amber-900 text-amber-300"
        }">${d.role}</span>
      </td>
      <td class="py-3 px-4 text-xs text-gray-500">${d.registered || "—"}</td>
      <td class="py-3 px-4">
        <form method="POST" action="/admin/update" class="flex gap-2 items-center">
          <input type="hidden" name="mac" value="${d.mac}">
          <select name="role" class="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300">
            ${["admin","user","guest"].map(r => `<option${d.role===r?" selected":""}>${r}</option>`).join("")}
          </select>
          <button class="text-xs px-2 py-1 bg-indigo-700 hover:bg-indigo-600 rounded text-white transition">Zapisz</button>
          <a href="/admin/delete/${d.mac}" onclick="return confirm('Usuń urządzenie?')"
             class="text-xs px-2 py-1 bg-red-900 hover:bg-red-800 rounded text-red-300 transition">✕</a>
        </form>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="py-6 text-center text-gray-600 text-sm">Brak zarejestrowanych urządzeń</td></tr>`;

  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Portal Admin — Urządzenia</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>body{background:#0f1117;font-family:system-ui,sans-serif;}</style>
</head>
<body class="text-gray-100 p-6">
  <div class="max-w-4xl mx-auto">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-xl font-bold">🖥️ Urządzenia w sieci</h1>
      <a href="/" class="text-xs text-gray-400 hover:text-white">← Portal</a>
    </div>

    <div style="background:#1a1d27;border:1px solid #2a2d3a" class="rounded-xl overflow-hidden">
      <table class="w-full">
        <thead><tr class="border-b border-gray-800 text-xs text-gray-400 uppercase">
          <th class="text-left py-3 px-4">Nazwa</th>
          <th class="text-left py-3 px-4">MAC</th>
          <th class="text-left py-3 px-4">Rola</th>
          <th class="text-left py-3 px-4">Data</th>
          <th class="text-left py-3 px-4">Akcje</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div style="background:#1a1d27;border:1px solid #2a2d3a" class="rounded-xl p-5 mt-4">
      <h2 class="text-sm font-semibold text-gray-400 mb-3">Dodaj urządzenie ręcznie</h2>
      <form method="POST" action="/admin/add" class="flex flex-wrap gap-3">
        <input name="mac" placeholder="MAC adres (aa:bb:cc:dd:ee:ff)"
               class="px-3 py-2 rounded-lg bg-gray-800 border border-gray-600 text-sm text-white flex-1 min-w-48">
        <input name="name" placeholder="Nazwa urządzenia"
               class="px-3 py-2 rounded-lg bg-gray-800 border border-gray-600 text-sm text-white flex-1 min-w-32">
        <select name="role" class="px-3 py-2 rounded-lg bg-gray-800 border border-gray-600 text-sm text-gray-300">
          <option value="guest">guest</option>
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
        <button class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white text-sm font-medium transition">Dodaj</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Main portal — detect device and show role-based page
app.get("/", (req, res) => {
  const ip = getClientIp(req);
  const mac = getMacByIp(ip);
  const device = findDevice(mac);
  res.send(renderPortal(device, ip, mac));
});

// Guest self-registration
app.post("/register", (req, res) => {
  const { mac, name } = req.body;
  if (!name?.trim()) return res.redirect("/");

  const db = loadDevices();
  const existing = db.devices.find(d => d.mac?.toLowerCase() === mac?.toLowerCase());
  if (!existing && mac) {
    db.devices.push({
      mac: mac.toLowerCase(),
      name: name.trim(),
      role: "guest",
      registered: new Date().toISOString().slice(0, 10),
    });
    saveDevices(db);
  }
  res.redirect("/");
});

// Admin panel — device management (only for admin role clients)
app.get("/admin", (req, res) => {
  const ip = getClientIp(req);
  const mac = getMacByIp(ip);
  const device = findDevice(mac);
  if (device?.role !== "admin") {
    return res.status(403).send("Brak dostępu. Ta strona jest tylko dla administratorów.");
  }
  res.send(renderAdminPanel());
});

app.post("/admin/add", (req, res) => {
  const ip = getClientIp(req);
  const mac = getMacByIp(ip);
  const device = findDevice(mac);
  if (device?.role !== "admin") return res.status(403).send("Brak dostępu");

  const { mac: newMac, name, role } = req.body;
  if (!newMac || !name) return res.redirect("/admin");

  const db = loadDevices();
  const idx = db.devices.findIndex(d => d.mac?.toLowerCase() === newMac.toLowerCase());
  const entry = { mac: newMac.toLowerCase(), name: name.trim(), role: role || "guest", registered: new Date().toISOString().slice(0, 10) };
  if (idx >= 0) db.devices[idx] = entry;
  else db.devices.push(entry);
  saveDevices(db);
  res.redirect("/admin");
});

app.post("/admin/update", (req, res) => {
  const ip = getClientIp(req);
  const mac = getMacByIp(ip);
  const device = findDevice(mac);
  if (device?.role !== "admin") return res.status(403).send("Brak dostępu");

  const { mac: targetMac, role } = req.body;
  const db = loadDevices();
  const d = db.devices.find(x => x.mac?.toLowerCase() === targetMac?.toLowerCase());
  if (d && ["admin","user","guest"].includes(role)) d.role = role;
  saveDevices(db);
  res.redirect("/admin");
});

app.get("/admin/delete/:mac", (req, res) => {
  const ip = getClientIp(req);
  const mac = getMacByIp(ip);
  const device = findDevice(mac);
  if (device?.role !== "admin") return res.status(403).send("Brak dostępu");

  const db = loadDevices();
  db.devices = db.devices.filter(d => d.mac?.toLowerCase() !== req.params.mac.toLowerCase());
  saveDevices(db);
  res.redirect("/admin");
});

// API for Discord bot integration
app.get("/api/devices", (req, res) => {
  const key = req.headers["x-api-key"];
  if (key !== process.env.AGENT_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  res.json(loadDevices());
});

app.listen(PORT, () => {
  console.log(`[Portal] Running on :${PORT}`);
  fs.mkdirSync(path.dirname(DEVICES_FILE), { recursive: true });
  if (!fs.existsSync(DEVICES_FILE)) saveDevices({ devices: [] });
});
