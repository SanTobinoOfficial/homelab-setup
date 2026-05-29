require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const ALLOWED_CHANNEL   = process.env.ALLOWED_CHANNEL_ID;
const ADMIN_USER_ID     = process.env.ADMIN_USER_ID;
const AGENT_URL         = process.env.AGENT_URL || "http://localhost:9090";
const AGENT_API_KEY     = process.env.AGENT_API_KEY || "";
const CLAUDE_CLI        = process.env.CLAUDE_CLI || "claude";
const CLAUDE_TIMEOUT    = parseInt(process.env.CLAUDE_TIMEOUT || "120") * 1000;

if (!DISCORD_TOKEN) { console.error("DISCORD_TOKEN not set"); process.exit(1); }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Agent API helper ──────────────────────────────────────────────────────────
async function agentFetch(path, method = "GET", body = null) {
  const fetch = (await import("node-fetch")).default;
  const opts = {
    method,
    headers: { "X-API-Key": AGENT_API_KEY, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(AGENT_URL + path, opts);
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isAdmin(msg) {
  return ADMIN_USER_ID ? msg.author.id === ADMIN_USER_ID : true;
}

function chunk(str, size = 1900) {
  const parts = [];
  for (let i = 0; i < str.length; i += size) parts.push(str.slice(i, i + size));
  return parts;
}

async function sendLong(msg, text, lang = "") {
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i++) {
    await msg.channel.send(`\`\`\`${lang}\n${parts[i]}\n\`\`\``);
  }
}

function uptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function statusEmoji(s) { return s === "running" ? "🟢" : "🔴"; }

// ── Command handlers ──────────────────────────────────────────────────────────
const commands = {

  async status(msg) {
    const typing = await msg.channel.sendTyping();
    try {
      const [metrics, services, storage] = await Promise.all([
        agentFetch("/api/metrics"),
        agentFetch("/api/services"),
        agentFetch("/api/storage"),
      ]);

      const embed = new EmbedBuilder()
        .setColor(0x6366f1)
        .setTitle("🖥️ HomeLab Server Status")
        .setTimestamp()
        .addFields(
          {
            name: "📊 Metryki",
            value: [
              `CPU: **${metrics.cpu_percent ?? "?"}%**`,
              `RAM: **${metrics.ram_used_mb ?? "?"}/${metrics.ram_total_mb ?? "?"}MB** (${metrics.ram_percent ?? "?"}%)`,
              `Temp: **${metrics.temp_celsius != null ? metrics.temp_celsius + "°C" : "N/A"}**`,
              `Uptime: **${metrics.uptime_seconds ? uptime(metrics.uptime_seconds) : "?"}**`,
            ].join("\n"),
            inline: true,
          },
          {
            name: "💾 Storage",
            value: [
              `Zajęte: **${storage.disk_used_gb ?? "?"}GB**`,
              `Wolne: **${storage.disk_free_gb ?? "?"}GB**`,
              `Łącznie: **${storage.disk_total_gb ?? "?"}GB**`,
              `Użycie: **${storage.disk_percent ?? "?"}%**`,
            ].join("\n"),
            inline: true,
          },
          {
            name: "🐳 Usługi",
            value: Array.isArray(services)
              ? services.map(s => `${statusEmoji(s.status)} \`${s.name}\` — ${s.status}`).join("\n") || "Brak"
              : "Błąd",
            inline: false,
          }
        );

      await msg.channel.send({ embeds: [embed] });
    } catch (e) {
      await msg.reply(`❌ Błąd połączenia z serwerem: ${e.message}`);
    }
  },

  async metrics(msg) {
    try {
      const m = await agentFetch("/api/metrics");
      await msg.reply([
        "**📊 Metryki systemu:**",
        `CPU: ${m.cpu_percent}%`,
        `RAM: ${m.ram_used_mb}/${m.ram_total_mb} MB (${m.ram_percent}%)`,
        `Dysk: ${m.disk_used_gb}/${m.disk_total_gb} GB (${m.disk_percent}%)`,
        `Temp: ${m.temp_celsius ?? "N/A"}°C`,
        `Uptime: ${uptime(m.uptime_seconds || 0)}`,
      ].join("\n"));
    } catch (e) {
      await msg.reply(`❌ ${e.message}`);
    }
  },

  async services(msg) {
    try {
      const list = await agentFetch("/api/services");
      if (!Array.isArray(list) || list.length === 0) return msg.reply("Brak usług");
      const text = list.map(s =>
        `${statusEmoji(s.status)} **${s.name}** — \`${s.status}\`${s.ports ? `  \`${s.ports}\`` : ""}`
      ).join("\n");
      await msg.reply(text);
    } catch (e) {
      await msg.reply(`❌ ${e.message}`);
    }
  },

  async restart(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const svc = args[0];
    if (!svc) return msg.reply("Użycie: `!restart <nazwa_usługi>`");
    const typing = msg.channel.sendTyping();
    try {
      const r = await agentFetch("/api/services/restart", "POST", { service: svc });
      r.success
        ? await msg.reply(`✅ \`${svc}\` zrestartowany`)
        : await msg.reply(`❌ Błąd: ${r.error || r.output}`);
    } catch (e) {
      await msg.reply(`❌ ${e.message}`);
    }
  },

  async stop(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const svc = args[0];
    if (!svc) return msg.reply("Użycie: `!stop <nazwa_usługi>`");
    try {
      const r = await agentFetch("/api/services/stop", "POST", { service: svc });
      r.success
        ? await msg.reply(`⏹️ \`${svc}\` zatrzymany`)
        : await msg.reply(`❌ Błąd: ${r.error}`);
    } catch (e) {
      await msg.reply(`❌ ${e.message}`);
    }
  },

  async logs(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const svc = args[0];
    const lines = parseInt(args[1] || "50");
    if (!svc) return msg.reply("Użycie: `!logs <usługa> [liczba_linii]`");
    try {
      const r = await agentFetch(`/api/logs/${svc}`);
      const text = (r.logs || []).filter(Boolean).slice(-lines).join("\n") || "Brak logów";
      await sendLong(msg, `=== Logi: ${svc} ===\n${text}`, "");
    } catch (e) {
      await msg.reply(`❌ ${e.message}`);
    }
  },

  async storage(msg) {
    try {
      const s = await agentFetch("/api/storage");
      const pct = s.disk_percent || 0;
      const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
      await msg.reply([
        "**💾 Storage (/mnt/ssd):**",
        `\`${bar}\` ${pct}%`,
        `Zajęte: **${s.disk_used_gb} GB**  |  Wolne: **${s.disk_free_gb} GB**  |  Łącznie: **${s.disk_total_gb} GB**`,
      ].join("\n"));
    } catch (e) {
      await msg.reply(`❌ ${e.message}`);
    }
  },

  // Run Claude Code non-interactively
  async claude(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const prompt = args.join(" ");
    if (!prompt) return msg.reply("Użycie: `!claude <twój prompt>`");

    await msg.reply(`🤖 Wysyłam do Claude Code:\n> ${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}`);
    await msg.channel.sendTyping();

    const waiting = setInterval(() => msg.channel.sendTyping(), 8000);
    try {
      const result = await new Promise((resolve, reject) => {
        let output = "";
        let errout = "";
        const proc = spawn(CLAUDE_CLI, ["--print", prompt], {
          timeout: CLAUDE_TIMEOUT,
          cwd: "/opt/homelab",
        });
        proc.stdout.on("data", d => (output += d));
        proc.stderr.on("data", d => (errout += d));
        proc.on("close", code => {
          if (code === 0) resolve(output || "(brak odpowiedzi)");
          else reject(new Error(errout || `Kod wyjścia: ${code}`));
        });
        proc.on("error", reject);
      });
      clearInterval(waiting);
      await sendLong(msg, `**Claude Code odpowiedział:**\n${result}`);
    } catch (e) {
      clearInterval(waiting);
      await msg.reply(`❌ Claude Code error: ${e.message.slice(0, 500)}`);
    }
  },

  // Run shell command (admin only, use carefully)
  async run(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const cmd = args.join(" ");
    if (!cmd) return msg.reply("Użycie: `!run <komenda>`");

    const BLOCKED = ["rm -rf /", "format", "dd if=", "mkfs", "> /dev/"];
    if (BLOCKED.some(b => cmd.includes(b))) return msg.reply("❌ Zablokowane polecenie");

    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", cmd], {
        timeout: 30000,
        cwd: "/opt/homelab",
      });
      const out = (stdout + stderr).trim() || "(brak output)";
      await sendLong(msg, `$ ${cmd}\n${out}`, "bash");
    } catch (e) {
      await sendLong(msg, `$ ${cmd}\nBłąd: ${e.message}`, "bash");
    }
  },

  async devices(msg) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    try {
      const fetch = (await import("node-fetch")).default;
      const res = await fetch("http://localhost:8888/api/devices", {
        headers: { "X-API-Key": AGENT_API_KEY },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      const list = (data.devices || []);
      if (list.length === 0) return msg.reply("Brak zarejestrowanych urządzeń.");
      const roleEmoji = { admin: "👑", user: "👤", guest: "👥" };
      const text = list.map(d =>
        `${roleEmoji[d.role] || "❓"} **${d.name}** \`${d.mac}\` — \`${d.role}\``
      ).join("\n");
      await msg.reply(`**📱 Urządzenia w portalu:**\n${text}`);
    } catch (e) {
      await msg.reply(`❌ ${e.message}`);
    }
  },

  async assign(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const [mac, role, ...nameParts] = args;
    if (!mac || !role) return msg.reply("Użycie: `!assign <mac> <admin|user|guest> [nazwa]`");
    if (!["admin","user","guest"].includes(role)) return msg.reply("❌ Rola musi być: admin, user lub guest");
    const name = nameParts.join(" ") || "Unnamed";
    try {
      const r = await execFileAsync("python3", [
        "/opt/homelab/user-portal/watcher.py", "assign", mac, role, name
      ], { timeout: 5000 });
      await msg.reply(`✅ Przypisano: \`${mac}\` → **${role}** (${name})`);
    } catch (e) {
      await msg.reply(`❌ ${e.message}`);
    }
  },

  async help(msg) {
    const embed = new EmbedBuilder()
      .setColor(0x6366f1)
      .setTitle("🏠 HomeLab Bot — Pomoc")
      .setDescription("Komendy do zarządzania homelab server node")
      .addFields(
        { name: "📊 Monitoring", value: [
          "`!status` — pełny status serwera",
          "`!metrics` — CPU, RAM, temp, uptime",
          "`!services` — lista usług Docker",
          "`!storage` — info o dysku SSD",
        ].join("\n"), inline: false },
        { name: "⚙️ Zarządzanie (admin)", value: [
          "`!restart <usługa>` — restart kontenera",
          "`!stop <usługa>` — zatrzymaj kontener",
          "`!logs <usługa> [linie]` — logi kontenera",
          "`!run <komenda>` — wykonaj komendę bash",
        ].join("\n"), inline: false },
        { name: "📱 User Portal", value: [
          "`!devices` — lista urządzeń z przypisanymi rolami",
          "`!assign <mac> <rola> [nazwa]` — przypisz rolę urządzeniu",
          "Przykład: `!assign aa:bb:cc:dd:ee:ff user Telefon Marka`",
        ].join("\n"), inline: false },
        { name: "🤖 Claude Code (admin)", value: [
          "`!claude <prompt>` — wyślij prompt do Claude Code CLI",
          "Przykład: `!claude sprawdź status usług i powiedz co nie działa`",
        ].join("\n"), inline: false },
      )
      .setFooter({ text: `Bot działa na: ${process.env.AGENT_URL?.replace("http://","").split(":")[0] || "localhost"}` });
    await msg.channel.send({ embeds: [embed] });
  },
};

// ── Message handler ───────────────────────────────────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (ALLOWED_CHANNEL && msg.channelId !== ALLOWED_CHANNEL) return;
  if (!msg.content.startsWith("!")) return;

  const [rawCmd, ...args] = msg.content.slice(1).trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();

  if (commands[cmd]) {
    try {
      await commands[cmd](msg, args);
    } catch (e) {
      console.error(`Command ${cmd} error:`, e);
      await msg.reply(`❌ Nieoczekiwany błąd: ${e.message.slice(0, 200)}`).catch(() => {});
    }
  }
});

client.once("ready", () => {
  console.log(`\n HomeLab Discord Bot`);
  console.log(` Logged in as: ${client.user.tag}`);
  console.log(` Agent URL:    ${AGENT_URL}`);
  console.log(` Channel:      ${ALLOWED_CHANNEL || "ALL channels"}`);
  console.log(` Admin:        ${ADMIN_USER_ID || "ALL users"}\n`);
  client.user.setActivity("🏠 HomeLab", { type: 3 });
});

client.login(DISCORD_TOKEN);
