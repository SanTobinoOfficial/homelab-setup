require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ThreadAutoArchiveDuration,
} = require("discord.js");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const ALLOWED_CHANNEL = process.env.ALLOWED_CHANNEL_ID;
const ADMIN_USER_ID   = process.env.ADMIN_USER_ID;
const AGENT_URL       = process.env.AGENT_URL       || "http://localhost:9090";
const AGENT_API_KEY   = process.env.AGENT_API_KEY   || "";
const CLAUDE_CLI      = process.env.CLAUDE_CLI      || "claude";
const CLAUDE_TIMEOUT  = parseInt(process.env.CLAUDE_TIMEOUT         || "120") * 1000;
const SESSION_TIMEOUT = parseInt(process.env.CLAUDE_SESSION_TIMEOUT || "30")  * 60 * 1000;

if (!DISCORD_TOKEN) { console.error("DISCORD_TOKEN not set"); process.exit(1); }

// Active Claude sessions: threadId → {history: [{role, content}], lastActivity}
const claudeSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of claudeSessions) {
    if (now - s.lastActivity > SESSION_TIMEOUT) claudeSessions.delete(id);
  }
}, 5 * 60 * 1000);

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

async function sendLong(target, text, lang = "") {
  for (const part of chunk(text)) {
    await target.send(`\`\`\`${lang}\n${part}\n\`\`\``);
  }
}

function uptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function statusEmoji(s) { return s === "running" ? "🟢" : "🔴"; }

// ── Claude runner (stream-json → thinking + response) ────────────────────────
async function runClaude(fullPrompt) {
  return new Promise((resolve, reject) => {
    let thinking = "";
    let response = "";
    let rawOutput = "";
    let buffer = "";

    const proc = spawn(CLAUDE_CLI, [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      fullPrompt,
    ], { cwd: "/opt/homelab", timeout: CLAUDE_TIMEOUT });

    proc.stdout.on("data", d => {
      const text = d.toString();
      rawOutput += text;
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
            for (const block of ev.message.content) {
              if (block.type === "thinking") thinking += block.thinking + "\n";
              if (block.type === "text") response += block.text;
            }
          } else if (ev.type === "result" && ev.result && !response) {
            response = ev.result;
          }
        } catch {
          // Not JSON line — treat as plain text (older CLI versions)
          if (!thinking && !response) response += line + "\n";
        }
      }
    });

    proc.on("close", code => {
      if (buffer.trim()) {
        try {
          const ev = JSON.parse(buffer);
          if (ev.type === "result" && !response) response = ev.result;
        } catch {
          if (!response) response += buffer;
        }
      }
      if (!response && rawOutput) {
        // Strip JSON lines, keep plain text lines as fallback
        response = rawOutput.split("\n")
          .filter(l => { try { JSON.parse(l); return false; } catch { return l.trim(); } })
          .join("\n").trim();
      }
      if (code === 0 || response) {
        resolve({ thinking: thinking.trim(), response: response.trim() || "(brak odpowiedzi)" });
      } else {
        reject(new Error(`Claude zakończył z kodem ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

function buildPromptWithHistory(history, userMessage) {
  const recent = history.slice(-10); // keep last 5 turns
  if (recent.length === 0) return userMessage;
  const ctx = recent.map(h => `${h.role === "user" ? "User" : "Claude"}: ${h.content}`).join("\n\n");
  return (
    `Kontynuujesz rozmowę. Historia:\n\n${ctx}\n\n` +
    `User: ${userMessage}\n\n` +
    `Odpowiedz na ostatnią wiadomość biorąc pod uwagę powyższy kontekst.`
  );
}

async function sendClaudeResult(target, result) {
  if (result.thinking) {
    const t = result.thinking.slice(0, 1800);
    const suffix = result.thinking.length > 1800 ? "\n[...]" : "";
    await target.send(`💭 **Myślenie Claude:**\n\`\`\`\n${t}${suffix}\n\`\`\``);
  }
  const parts = chunk(result.response);
  for (let i = 0; i < parts.length; i++) {
    await target.send(i === 0 ? `🤖 **Claude:**\n${parts[i]}` : parts[i]);
  }
}

// ── Command handlers ──────────────────────────────────────────────────────────
const commands = {

  async status(msg) {
    await msg.channel.sendTyping();
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
          { name: "📊 Metryki", value: [
            `CPU: **${metrics.cpu_percent ?? "?"}%**`,
            `RAM: **${metrics.ram_used_mb ?? "?"}/${metrics.ram_total_mb ?? "?"}MB** (${metrics.ram_percent ?? "?"}%)`,
            `Temp: **${metrics.temp_celsius != null ? metrics.temp_celsius + "°C" : "N/A"}**`,
            `Uptime: **${metrics.uptime_seconds ? uptime(metrics.uptime_seconds) : "?"}**`,
          ].join("\n"), inline: true },
          { name: "💾 Storage", value: [
            `Zajęte: **${storage.disk_used_gb ?? "?"}GB**`,
            `Wolne: **${storage.disk_free_gb ?? "?"}GB**`,
            `Łącznie: **${storage.disk_total_gb ?? "?"}GB**`,
            `Użycie: **${storage.disk_percent ?? "?"}%**`,
          ].join("\n"), inline: true },
          { name: "🐳 Usługi", value: Array.isArray(services)
            ? services.map(s => `${statusEmoji(s.status)} \`${s.name}\` — ${s.status}`).join("\n") || "Brak"
            : "Błąd", inline: false },
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
    try {
      const r = await agentFetch("/api/services/restart", "POST", { service: svc });
      r.success ? await msg.reply(`✅ \`${svc}\` zrestartowany`) : await msg.reply(`❌ Błąd: ${r.error || r.output}`);
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
      r.success ? await msg.reply(`⏹️ \`${svc}\` zatrzymany`) : await msg.reply(`❌ Błąd: ${r.error}`);
    } catch (e) {
      await msg.reply(`❌ ${e.message}`);
    }
  },

  async logs(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const svc = args[0], lines = parseInt(args[1] || "50");
    if (!svc) return msg.reply("Użycie: `!logs <usługa> [liczba_linii]`");
    try {
      const r = await agentFetch(`/api/logs/${svc}`);
      const text = (r.logs || []).filter(Boolean).slice(-lines).join("\n") || "Brak logów";
      await sendLong(msg.channel, `=== Logi: ${svc} ===\n${text}`);
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

  // Open a Claude chat thread — each message in the thread continues the conversation
  async claude(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const initialPrompt = args.join(" ");
    if (!initialPrompt) return msg.reply(
      "Użycie: `!claude <prompt>` — otwiera wątek czatu z Claude\n" +
      "W wątku pisz bezpośrednio. `!exit` kończy sesję."
    );

    let thread;
    try {
      thread = await msg.startThread({
        name: `🤖 Claude: ${initialPrompt.slice(0, 80)}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
    } catch (e) {
      return msg.reply(`❌ Nie mogę utworzyć wątku: ${e.message}`);
    }

    claudeSessions.set(thread.id, { history: [], lastActivity: Date.now() });

    await thread.send(
      `🤖 **Sesja Claude Code — czat jak w terminalu**\n` +
      `• Pisz bezpośrednio tutaj — każda wiadomość trafia do Claude\n` +
      `• Widoczne myślenie Claude (💭) i pełna historia rozmowy\n` +
      `• \`!exit\` — zakończ i zarchiwizuj wątek\n` +
      `• Sesja wygasa po ${SESSION_TIMEOUT / 60000} min nieaktywności\n` +
      `${"─".repeat(44)}`
    );

    await thread.sendTyping();
    const typing = setInterval(() => thread.sendTyping(), 8000);
    try {
      const result = await runClaude(initialPrompt);
      clearInterval(typing);
      const session = claudeSessions.get(thread.id);
      if (session) {
        session.history.push({ role: "user", content: initialPrompt });
        session.history.push({ role: "assistant", content: result.response });
        session.lastActivity = Date.now();
      }
      await sendClaudeResult(thread, result);
    } catch (e) {
      clearInterval(typing);
      await thread.send(`❌ Błąd Claude: ${e.message.slice(0, 500)}`);
    }
  },

  async run(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const cmd = args.join(" ");
    if (!cmd) return msg.reply("Użycie: `!run <komenda>`");
    const BLOCKED = ["rm -rf /", "format", "dd if=", "mkfs", "> /dev/"];
    if (BLOCKED.some(b => cmd.includes(b))) return msg.reply("❌ Zablokowane polecenie");
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", cmd], { timeout: 30000, cwd: "/opt/homelab" });
      await sendLong(msg.channel, `$ ${cmd}\n${(stdout + stderr).trim() || "(brak output)"}`, "bash");
    } catch (e) {
      await sendLong(msg.channel, `$ ${cmd}\nBłąd: ${e.message}`, "bash");
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
        { name: "🤖 Claude Code (admin)", value: [
          "`!claude <prompt>` — otwiera wątek czatu z Claude",
          "W wątku: pisz bezpośrednio | `!exit` zakończ sesję",
          "Widać: myślenie Claude (💭) + pełna historia",
        ].join("\n"), inline: false },
      )
      .setFooter({ text: `Bot: ${process.env.AGENT_URL?.replace("http://","").split(":")[0] || "localhost"}` });
    await msg.channel.send({ embeds: [embed] });
  },
};

// ── Message handler ───────────────────────────────────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  // Handle messages inside an active Claude session thread
  if (claudeSessions.has(msg.channelId)) {
    const session = claudeSessions.get(msg.channelId);

    if (msg.content.trim().toLowerCase() === "!exit") {
      claudeSessions.delete(msg.channelId);
      await msg.reply("👋 Sesja Claude zakończona.");
      try { await msg.channel.setArchived(true); } catch {}
      return;
    }

    if (msg.content.startsWith("!")) return; // ignore other !commands inside thread

    session.lastActivity = Date.now();
    await msg.channel.sendTyping();
    const typing = setInterval(() => msg.channel.sendTyping(), 8000);
    try {
      const fullPrompt = buildPromptWithHistory(session.history, msg.content);
      const result = await runClaude(fullPrompt);
      clearInterval(typing);
      session.history.push({ role: "user", content: msg.content });
      session.history.push({ role: "assistant", content: result.response });
      await sendClaudeResult(msg.channel, result);
    } catch (e) {
      clearInterval(typing);
      await msg.channel.send(`❌ Błąd Claude: ${e.message.slice(0, 500)}`);
    }
    return;
  }

  // Normal channel — only listen to allowed channel
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
