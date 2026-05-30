require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ThreadAutoArchiveDuration,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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

// Active Claude sessions: threadId → {history, lastActivity, proc, remoteUrl, mode}
const claudeSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of claudeSessions) {
    if (now - s.lastActivity > SESSION_TIMEOUT) {
      if (s.proc) s.proc.kill();
      claudeSessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Tool display metadata ─────────────────────────────────────────────────────
const TOOL_META = {
  Bash:       { emoji: "🔧", color: 0xf59e0b, label: "Bash" },
  Read:       { emoji: "📖", color: 0x3b82f6, label: "Odczyt pliku" },
  Write:      { emoji: "✏️",  color: 0xec4899, label: "Zapis pliku" },
  Edit:       { emoji: "✏️",  color: 0xec4899, label: "Edycja pliku" },
  MultiEdit:  { emoji: "✏️",  color: 0xec4899, label: "Edycja plików" },
  Glob:       { emoji: "🔍", color: 0x6366f1, label: "Glob" },
  Grep:       { emoji: "🔍", color: 0x6366f1, label: "Grep" },
  LS:         { emoji: "📁", color: 0x10b981, label: "Listowanie" },
  WebSearch:  { emoji: "🌐", color: 0x0ea5e9, label: "Web Search" },
  WebFetch:   { emoji: "🌐", color: 0x0ea5e9, label: "Web Fetch" },
  TodoRead:   { emoji: "📋", color: 0x8b5cf6, label: "Todo" },
  TodoWrite:  { emoji: "📋", color: 0x8b5cf6, label: "Todo Update" },
};

function getMeta(name) {
  return TOOL_META[name] || { emoji: "⚙️", color: 0x6b7280, label: name };
}

function fmtInput(name, input) {
  if (!input) return "";
  if (typeof input !== "object") return String(input).slice(0, 900);
  if (name === "Bash") return ("$ " + (input.command || "")).slice(0, 900);
  if (["Read", "Write", "Edit", "MultiEdit"].includes(name))
    return (input.file_path || input.path || JSON.stringify(input)).slice(0, 900);
  return JSON.stringify(input, null, 2).slice(0, 900);
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

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

// ── Control buttons ───────────────────────────────────────────────────────────
function controlRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("claude_stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("claude_clear").setLabel("🔄 Nowa sesja").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("claude_exit").setLabel("🚪 Zakończ").setStyle(ButtonStyle.Secondary),
  );
}

// ── Start interactive Claude session with Remote Control ──────────────────────
// Returns the Remote Control URL if supported, or null if fallback needed.
function startRemoteSession(thread, initialMessage, session) {
  return new Promise((resolve) => {
    let urlFound = false;
    let buffer   = "";
    const events = [];

    const proc = spawn(CLAUDE_CLI, [
      "--remote-control",
      "--output-format", "stream-json",
    ], { cwd: "/opt/homelab", stdio: ["pipe", "pipe", "pipe"] });

    session.proc = proc;
    session.mode = "remote";

    // Detect Remote Control URL in any output
    const detectUrl = (text) => {
      if (urlFound) return;
      const m = text.match(/https:\/\/claude\.ai\/code\/[^\s"'\n\r]+/);
      if (m) {
        urlFound = true;
        resolve(m[0]);
      }
    };

    // Parse structured JSON events for Discord embeds (best-effort)
    proc.stdout.on("data", (d) => {
      const raw = d.toString();
      detectUrl(raw);
      buffer += raw;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch {}
      }
    });

    proc.stderr.on("data", (d) => detectUrl(d.toString()));

    // Relay structured tool call events to Discord in background
    const relayLoop = setInterval(async () => {
      while (events.length > 0) {
        const ev = events.shift();
        try { await relayEvent(thread, ev, session); } catch {}
      }
    }, 500);

    proc.on("close", (code) => {
      session.proc = null;
      clearInterval(relayLoop);
      if (!urlFound) resolve(null); // signal fallback needed
      thread.send({ embeds: [new EmbedBuilder().setColor(0x374151).setDescription(`ℹ️ Sesja Claude zakończona (kod: ${code}).`)] }).catch(() => {});
    });

    proc.on("error", (err) => {
      session.proc = null;
      clearInterval(relayLoop);
      if (!urlFound) resolve(null);
      thread.send(`❌ Błąd uruchomienia Claude: ${err.message.slice(0, 200)}`).catch(() => {});
    });

    // Send initial message after Claude initialises (~1.5s)
    setTimeout(() => {
      if (initialMessage && proc.stdin && !proc.killed) {
        proc.stdin.write(initialMessage + "\n");
      }
    }, 1500);

    // If no URL after 20s → fallback
    setTimeout(() => { if (!urlFound) resolve(null); }, 20000);
  });
}

// Relay a single stream-json event to Discord thread
const toolMsgMap = new WeakMap(); // session → Map<tool_use_id, msg>
async function relayEvent(thread, ev, session) {
  if (!toolMsgMap.has(session)) toolMsgMap.set(session, new Map());
  const tmap = toolMsgMap.get(session);

  if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === "thinking") {
        const t = block.thinking.slice(0, 3900);
        await thread.send({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setAuthor({ name: "💭 Myślenie" }).setDescription(`\`\`\`\n${t}\n\`\`\``)] });
      } else if (block.type === "text" && block.text.trim()) {
        for (const part of chunk(block.text.trim(), 3900)) {
          await thread.send({ embeds: [new EmbedBuilder().setColor(0x6366f1).setAuthor({ name: "🤖 Claude" }).setDescription(part)] });
        }
      } else if (block.type === "tool_use") {
        const meta = getMeta(block.name);
        const embed = new EmbedBuilder().setColor(meta.color).setAuthor({ name: `${meta.emoji} ${meta.label}` }).setDescription(`\`\`\`\n${fmtInput(block.name, block.input)}\n\`\`\``).setFooter({ text: "⏳ Uruchamianie..." });
        const m = await thread.send({ embeds: [embed] });
        tmap.set(block.id, { msg: m, meta, inputFmt: fmtInput(block.name, block.input) });
      }
    }
  } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type !== "tool_result") continue;
      const entry = tmap.get(block.tool_use_id);
      if (!entry) continue;
      const output = (Array.isArray(block.content) ? block.content.map(c => c.text || "").join("\n") : String(block.content || "")).slice(0, 900);
      const isErr = !!block.is_error;
      await entry.msg.edit({ embeds: [new EmbedBuilder().setColor(isErr ? 0xef4444 : 0x10b981).setAuthor({ name: `${entry.meta.emoji} ${entry.meta.label}` }).setDescription(`\`\`\`\n${entry.inputFmt}\n\`\`\``).addFields({ name: isErr ? "❌ Błąd" : "📤 Wynik", value: `\`\`\`\n${output || "(brak)"}\n\`\`\`` }).setFooter({ text: isErr ? "Błąd ❌" : "Ukończono ✅" })] });
      tmap.delete(block.tool_use_id);
    }
  } else if (ev.type === "result") {
    const parts = [];
    if (ev.duration_ms) parts.push(`⏱ ${(ev.duration_ms / 1000).toFixed(1)}s`);
    if (ev.total_cost_usd != null) parts.push(`💰 $${ev.total_cost_usd.toFixed(4)}`);
    if (ev.num_turns) parts.push(`🔄 ${ev.num_turns} tur`);
    if (parts.length) await thread.send({ embeds: [new EmbedBuilder().setColor(0x1f2937).setFooter({ text: parts.join("  •  ") })] });
  }
}

// ── Fallback: non-interactive --print mode ────────────────────────────────────
function runClaudePrint(fullPrompt, session) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = "", errOut = "";

    const proc = spawn(CLAUDE_CLI, [
      "--print", "--output-format", "stream-json", "--verbose", fullPrompt,
    ], { cwd: "/opt/homelab", timeout: CLAUDE_TIMEOUT, stdio: ["ignore", "pipe", "pipe"] });

    session.proc = proc;

    proc.stdout.on("data", d => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch {}
      }
    });
    proc.stderr.on("data", d => errOut += d);

    proc.on("close", async (code) => {
      session.proc = null;
      if (code !== 0 && events.length === 0) return reject(new Error(errOut.trim() || `Kod ${code}`));
      resolve(events);
    });
    proc.on("error", reject);
  });
}

function buildPromptWithHistory(history, userMessage) {
  const recent = history.slice(-10);
  if (recent.length === 0) return userMessage;
  const ctx = recent.map(h => `${h.role === "user" ? "User" : "Claude"}: ${h.content}`).join("\n\n");
  return `Kontynuujesz rozmowę. Historia:\n\n${ctx}\n\nUser: ${userMessage}\n\nOdpowiedz na ostatnią wiadomość.`;
}

// ── Command handlers ──────────────────────────────────────────────────────────
const commands = {

  async status(msg) {
    await msg.channel.sendTyping();
    try {
      const [metrics, services, storage] = await Promise.all([
        agentFetch("/api/metrics"), agentFetch("/api/services"), agentFetch("/api/storage"),
      ]);
      const embed = new EmbedBuilder().setColor(0x6366f1).setTitle("🖥️ HomeLab Server Status").setTimestamp()
        .addFields(
          { name: "📊 Metryki", value: [`CPU: **${metrics.cpu_percent ?? "?"}%**`, `RAM: **${metrics.ram_used_mb ?? "?"}/${metrics.ram_total_mb ?? "?"}MB** (${metrics.ram_percent ?? "?"}%)`, `Temp: **${metrics.temp_celsius != null ? metrics.temp_celsius + "°C" : "N/A"}**`, `Uptime: **${metrics.uptime_seconds ? uptime(metrics.uptime_seconds) : "?"}**`].join("\n"), inline: true },
          { name: "💾 Storage", value: [`Zajęte: **${storage.disk_used_gb ?? "?"}GB**`, `Wolne: **${storage.disk_free_gb ?? "?"}GB**`, `Łącznie: **${storage.disk_total_gb ?? "?"}GB**`, `Użycie: **${storage.disk_percent ?? "?"}%**`].join("\n"), inline: true },
          { name: "🐳 Usługi", value: Array.isArray(services) ? services.map(s => `${statusEmoji(s.status)} \`${s.name}\` — ${s.status}`).join("\n") || "Brak" : "Błąd", inline: false },
        );
      await msg.channel.send({ embeds: [embed] });
    } catch (e) { await msg.reply(`❌ Błąd: ${e.message}`); }
  },

  async metrics(msg) {
    try {
      const m = await agentFetch("/api/metrics");
      await msg.reply(["**📊 Metryki systemu:**", `CPU: ${m.cpu_percent}%`, `RAM: ${m.ram_used_mb}/${m.ram_total_mb} MB (${m.ram_percent}%)`, `Dysk: ${m.disk_used_gb}/${m.disk_total_gb} GB (${m.disk_percent}%)`, `Temp: ${m.temp_celsius ?? "N/A"}°C`, `Uptime: ${uptime(m.uptime_seconds || 0)}`].join("\n"));
    } catch (e) { await msg.reply(`❌ ${e.message}`); }
  },

  async services(msg) {
    try {
      const list = await agentFetch("/api/services");
      if (!Array.isArray(list) || list.length === 0) return msg.reply("Brak usług");
      await msg.reply(list.map(s => `${statusEmoji(s.status)} **${s.name}** — \`${s.status}\`${s.ports ? `  \`${s.ports}\`` : ""}`).join("\n"));
    } catch (e) { await msg.reply(`❌ ${e.message}`); }
  },

  async restart(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const svc = args[0];
    if (!svc) return msg.reply("Użycie: `!restart <usługa>`");
    try {
      const r = await agentFetch("/api/services/restart", "POST", { service: svc });
      r.success ? await msg.reply(`✅ \`${svc}\` zrestartowany`) : await msg.reply(`❌ ${r.error || r.output}`);
    } catch (e) { await msg.reply(`❌ ${e.message}`); }
  },

  async stop(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const svc = args[0];
    if (!svc) return msg.reply("Użycie: `!stop <usługa>`");
    try {
      const r = await agentFetch("/api/services/stop", "POST", { service: svc });
      r.success ? await msg.reply(`⏹️ \`${svc}\` zatrzymany`) : await msg.reply(`❌ ${r.error}`);
    } catch (e) { await msg.reply(`❌ ${e.message}`); }
  },

  async logs(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const svc = args[0], lines = parseInt(args[1] || "50");
    if (!svc) return msg.reply("Użycie: `!logs <usługa> [linie]`");
    try {
      const r = await agentFetch(`/api/logs/${svc}`);
      await sendLong(msg.channel, `=== Logi: ${svc} ===\n${(r.logs || []).filter(Boolean).slice(-lines).join("\n") || "Brak logów"}`);
    } catch (e) { await msg.reply(`❌ ${e.message}`); }
  },

  async storage(msg) {
    try {
      const s = await agentFetch("/api/storage");
      const pct = s.disk_percent || 0;
      const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
      await msg.reply(["**💾 Storage (/mnt/ssd):**", `\`${bar}\` ${pct}%`, `Zajęte: **${s.disk_used_gb} GB**  |  Wolne: **${s.disk_free_gb} GB**  |  Łącznie: **${s.disk_total_gb} GB**`].join("\n"));
    } catch (e) { await msg.reply(`❌ ${e.message}`); }
  },

  // Open Claude thread with Remote Control
  async claude(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const initialPrompt = args.join(" ");
    if (!initialPrompt) return msg.reply("Użycie: `!claude <prompt>` — otwiera wątek + Remote Control na telefon");

    let thread;
    try {
      thread = await msg.startThread({
        name: `🤖 Claude: ${initialPrompt.slice(0, 80)}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
    } catch (e) { return msg.reply(`❌ Nie mogę utworzyć wątku: ${e.message}`); }

    const session = { history: [], lastActivity: Date.now(), proc: null, remoteUrl: null, mode: "remote" };
    claudeSessions.set(thread.id, session);

    await thread.send({
      embeds: [new EmbedBuilder()
        .setColor(0x6366f1)
        .setTitle("🤖 Sesja Claude Code")
        .setDescription("Uruchamianie Remote Control...\n• 📱 Link do oficjalnej aplikacji Claude pojawi się za chwilę\n• Możesz też pisać bezpośrednio tutaj w wątku\n• Narzędzia: 💭 myślenie · 🔧 bash · ✏️ pliki · 💰 koszt")
        .setFooter({ text: `Skip-permissions · Wygasa po ${SESSION_TIMEOUT / 60000}min` })
      ],
      components: [controlRow()],
    });

    await thread.sendTyping();
    const typing = setInterval(() => thread.sendTyping(), 8000);

    // Try Remote Control first
    const url = await startRemoteSession(thread, initialPrompt, session);
    clearInterval(typing);

    if (url) {
      // Remote Control succeeded — send the link
      session.remoteUrl = url;
      await thread.send({
        embeds: [new EmbedBuilder()
          .setColor(0x059669)
          .setTitle("📱 Remote Control — otwórz na telefonie")
          .setDescription(`**[Kliknij tutaj aby otworzyć w aplikacji Claude](${url})**\n\`${url}\`\n\nMożesz też pisać tutaj w wątku — obie opcje działają jednocześnie.`)
          .setFooter({ text: "Wymaga Claude app lub przeglądarki · claude.ai/code" })
        ],
      });
    } else {
      // Fallback: Remote Control not supported by this CLI version
      session.mode = "print";
      await thread.send({
        embeds: [new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle("⚠️ Remote Control niedostępny")
          .setDescription("Ta wersja Claude CLI nie obsługuje `--remote-control`.\nSesja działa w trybie Discord (embedy narzędzi).\n\nAby włączyć Remote Control: `npm update -g @anthropic-ai/claude-code`")
        ],
      });
      // Run initial prompt in fallback print mode
      try {
        const events = await runClaudePrint(initialPrompt, session);
        for (const ev of events) await relayEvent(thread, ev, session).catch(() => {});
      } catch (e) {
        await thread.send(`❌ Błąd: ${e.message.slice(0, 400)}`);
      }
    }
  },

  async run(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const cmd = args.join(" ");
    if (!cmd) return msg.reply("Użycie: `!run <komenda>`");
    const BLOCKED = ["rm -rf /", "format", "dd if=", "mkfs", "> /dev/"];
    if (BLOCKED.some(b => cmd.includes(b))) return msg.reply("❌ Zablokowane");
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", cmd], { timeout: 30000, cwd: "/opt/homelab" });
      await sendLong(msg.channel, `$ ${cmd}\n${(stdout + stderr).trim() || "(brak output)"}`, "bash");
    } catch (e) { await sendLong(msg.channel, `$ ${cmd}\nBłąd: ${e.message}`, "bash"); }
  },

  async help(msg) {
    const embed = new EmbedBuilder().setColor(0x6366f1).setTitle("🏠 HomeLab Bot — Pomoc").setDescription("Komendy do zarządzania homelab server node")
      .addFields(
        { name: "📊 Monitoring", value: ["`!status` — pełny status", "`!metrics` — CPU, RAM, temp", "`!services` — usługi Docker", "`!storage` — dysk SSD"].join("\n"), inline: false },
        { name: "⚙️ Zarządzanie (admin)", value: ["`!restart <usługa>`", "`!stop <usługa>`", "`!logs <usługa> [linie]`", "`!run <komenda>`"].join("\n"), inline: false },
        { name: "🤖 Claude Code (admin)", value: ["`!claude <prompt>` — wątek + Remote Control na telefon", "Dostęp: Discord thread lub oficjalna aplikacja Claude", "Widać: 💭 🔧 ✏️ 📤 💰"].join("\n"), inline: false },
      ).setFooter({ text: `Bot: ${process.env.AGENT_URL?.replace("http://", "").split(":")[0] || "localhost"}` });
    await msg.channel.send({ embeds: [embed] });
  },
};

// ── Button interaction handler ────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("claude_")) return;
  const session = claudeSessions.get(interaction.channelId);
  if (!session) return interaction.reply({ content: "❌ Brak aktywnej sesji.", ephemeral: true });

  if (interaction.customId === "claude_stop") {
    if (session.proc) { session.proc.kill(); session.proc = null; }
    await interaction.reply({ content: "⏹ Zatrzymano.", ephemeral: true });

  } else if (interaction.customId === "claude_clear") {
    // Kill current proc and clear — user can type a new message to restart
    if (session.proc) { session.proc.kill(); session.proc = null; }
    session.history = [];
    session.remoteUrl = null;
    session.mode = "print";
    await interaction.reply({ content: "🔄 Sesja wyczyszczona. Napisz nową wiadomość.", ephemeral: true });

  } else if (interaction.customId === "claude_exit") {
    if (session.proc) session.proc.kill();
    claudeSessions.delete(interaction.channelId);
    await interaction.reply({ content: "👋 Sesja zakończona." });
    try { await interaction.channel.setArchived(true); } catch {}
  }
});

// ── Message handler ───────────────────────────────────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  // Handle active Claude session thread
  if (claudeSessions.has(msg.channelId)) {
    const session = claudeSessions.get(msg.channelId);

    if (msg.content.trim().toLowerCase() === "!exit") {
      if (session.proc) session.proc.kill();
      claudeSessions.delete(msg.channelId);
      await msg.reply("👋 Sesja Claude zakończona.");
      try { await msg.channel.setArchived(true); } catch {}
      return;
    }

    if (msg.content.startsWith("!")) return;

    session.lastActivity = Date.now();

    if (session.mode === "remote" && session.proc && !session.proc.killed) {
      // Forward to running interactive Claude process
      session.proc.stdin.write(msg.content + "\n");
      await msg.react("📨").catch(() => {});

    } else {
      // Fallback print mode (Remote Control not available or proc died)
      await msg.channel.sendTyping();
      const typing = setInterval(() => msg.channel.sendTyping(), 8000);
      try {
        const fullPrompt = buildPromptWithHistory(session.history, msg.content);
        const events = await runClaudePrint(fullPrompt, session);
        clearInterval(typing);
        let response = "";
        for (const ev of events) {
          await relayEvent(msg.channel, ev, session).catch(() => {});
          if (ev.type === "result" && ev.result) response = ev.result;
          if (ev.type === "assistant") {
            for (const b of ev.message?.content || []) if (b.type === "text") response += b.text;
          }
        }
        session.history.push({ role: "user", content: msg.content });
        session.history.push({ role: "assistant", content: response });
      } catch (e) {
        clearInterval(typing);
        await msg.channel.send(`❌ Błąd Claude: ${e.message.slice(0, 400)}`);
      }
    }
    return;
  }

  // Normal channel
  if (ALLOWED_CHANNEL && msg.channelId !== ALLOWED_CHANNEL) return;
  if (!msg.content.startsWith("!")) return;

  const [rawCmd, ...args] = msg.content.slice(1).trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  if (commands[cmd]) {
    try { await commands[cmd](msg, args); }
    catch (e) {
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
