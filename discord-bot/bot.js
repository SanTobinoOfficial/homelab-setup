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

// Active Claude sessions: threadId → {history, lastActivity, proc}
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
    new ButtonBuilder().setCustomId("claude_clear").setLabel("🔄 Wyczyść historię").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("claude_exit").setLabel("🚪 Zakończ").setStyle(ButtonStyle.Secondary),
  );
}

// ── Stream Claude to thread ───────────────────────────────────────────────────
function streamClaudeToThread(thread, fullPrompt, session) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = "";

    let errOutput = "";

    const proc = spawn(CLAUDE_CLI, [
      "--print",
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      fullPrompt,
    ], { cwd: "/opt/homelab", timeout: CLAUDE_TIMEOUT });

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

    proc.stderr.on("data", d => { errOutput += d.toString(); });

    proc.on("close", async (code) => {
      session.proc = null;

      // Fallback: if stream-json failed, retry with plain --print
      if (code !== 0 && events.length === 0) {
        try {
          const plain = await new Promise((res, rej) => {
            let out = "", err = "";
            const p = spawn(CLAUDE_CLI, ["--print", "--dangerously-skip-permissions", fullPrompt], { cwd: "/opt/homelab", timeout: CLAUDE_TIMEOUT });
            p.stdout.on("data", d => out += d);
            p.stderr.on("data", d => err += d);
            p.on("close", c => c === 0 ? res(out.trim()) : rej(new Error(err.trim() || `Kod ${c}`)));
            p.on("error", rej);
          });
          for (const part of chunk(plain || "(brak odpowiedzi)", 3900)) {
            await thread.send({ embeds: [new EmbedBuilder().setColor(0x6366f1).setAuthor({ name: "🤖 Claude" }).setDescription(part)] }).catch(() => {});
          }
          return resolve({ response: plain });
        } catch (fbErr) {
          return reject(new Error(`${fbErr.message} | stderr: ${errOutput.slice(0, 300)}`));
        }
      }

      const toolMsgs   = new Map(); // tool_use_id → {msg, meta, inputFmt}
      let thinkingText = "";
      let responseText = "";
      let costInfo     = null;

      for (const ev of events) {
        try {
          // ── Assistant message (thinking / text / tool_use) ────────────────
          if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
            for (const block of ev.message.content) {
              if (block.type === "thinking") {
                thinkingText += block.thinking + "\n";

              } else if (block.type === "text") {
                responseText += block.text;

              } else if (block.type === "tool_use") {
                const meta     = getMeta(block.name);
                const inputFmt = fmtInput(block.name, block.input);
                const embed = new EmbedBuilder()
                  .setColor(meta.color)
                  .setAuthor({ name: `${meta.emoji} ${meta.label}` })
                  .setDescription(`\`\`\`\n${inputFmt}\n\`\`\``)
                  .setFooter({ text: "⏳ Uruchamianie..." });
                const m = await thread.send({ embeds: [embed] });
                toolMsgs.set(block.id, { msg: m, meta, inputFmt });
              }
            }
          }

          // ── User message (tool_result) ────────────────────────────────────
          else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
            for (const block of ev.message.content) {
              if (block.type !== "tool_result") continue;
              const entry = toolMsgs.get(block.tool_use_id);
              if (!entry) continue;

              const output = (Array.isArray(block.content)
                ? block.content.map(c => c.text || "").join("\n")
                : String(block.content || "")
              ).slice(0, 900);

              const isErr = !!block.is_error;
              const updated = new EmbedBuilder()
                .setColor(isErr ? 0xef4444 : 0x10b981)
                .setAuthor({ name: `${entry.meta.emoji} ${entry.meta.label}` })
                .setDescription(`\`\`\`\n${entry.inputFmt}\n\`\`\``)
                .addFields({
                  name: isErr ? "❌ Błąd" : "📤 Wynik",
                  value: `\`\`\`\n${output || "(brak output)"}\n\`\`\``,
                })
                .setFooter({ text: isErr ? "Błąd ❌" : "Ukończono ✅" });
              await entry.msg.edit({ embeds: [updated] });
              toolMsgs.delete(block.tool_use_id);
            }
          }

          // ── Final result ──────────────────────────────────────────────────
          else if (ev.type === "result") {
            if (!responseText && ev.result) responseText = ev.result;
            costInfo = {
              cost:  ev.total_cost_usd != null ? `$${ev.total_cost_usd.toFixed(4)}` : null,
              dur:   ev.duration_ms    != null ? `${(ev.duration_ms / 1000).toFixed(1)}s` : null,
              turns: ev.num_turns,
            };
          }

        } catch (err) {
          console.error("Event processing error:", err.message);
        }
      }

      // Send thinking block
      if (thinkingText.trim()) {
        const t = thinkingText.trim().slice(0, 3900);
        await thread.send({
          embeds: [new EmbedBuilder()
            .setColor(0x8b5cf6)
            .setAuthor({ name: "💭 Myślenie Claude" })
            .setDescription(`\`\`\`\n${t}${thinkingText.length > 3900 ? "\n..." : ""}\n\`\`\``)
          ],
        }).catch(() => {});
      }

      // Send response (split into embed chunks, max 4096 per embed)
      if (responseText.trim()) {
        const parts = chunk(responseText.trim(), 3900);
        for (let i = 0; i < parts.length; i++) {
          await thread.send({
            embeds: [new EmbedBuilder()
              .setColor(0x6366f1)
              .setAuthor({ name: i === 0 ? "🤖 Claude" : "🤖 Claude (cd.)" })
              .setDescription(parts[i])
            ],
          }).catch(() => {});
        }
      }

      // Cost / duration footer
      if (costInfo) {
        const parts = [];
        if (costInfo.dur)            parts.push(`⏱ ${costInfo.dur}`);
        if (costInfo.cost)           parts.push(`💰 ${costInfo.cost}`);
        if (costInfo.turns != null)  parts.push(`🔄 ${costInfo.turns} tur`);
        if (parts.length) {
          await thread.send({
            embeds: [new EmbedBuilder()
              .setColor(0x1f2937)
              .setFooter({ text: parts.join("  •  ") })
            ],
          }).catch(() => {});
        }
      }

      resolve({ response: responseText });
    });

    proc.on("error", (err) => { session.proc = null; reject(err); });
  });
}

function buildPromptWithHistory(history, userMessage) {
  const recent = history.slice(-10);
  if (recent.length === 0) return userMessage;
  const ctx = recent.map(h => `${h.role === "user" ? "User" : "Claude"}: ${h.content}`).join("\n\n");
  return (
    `Kontynuujesz rozmowę. Historia:\n\n${ctx}\n\n` +
    `User: ${userMessage}\n\n` +
    `Odpowiedz na ostatnią wiadomość biorąc pod uwagę powyższy kontekst.`
  );
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

  // Open a Claude chat thread with full CLI-like experience
  async claude(msg, args) {
    if (!isAdmin(msg)) return msg.reply("❌ Brak uprawnień");
    const initialPrompt = args.join(" ");
    if (!initialPrompt) return msg.reply(
      "Użycie: `!claude <prompt>` — otwiera wątek czatu z Claude\n" +
      "W wątku pisz bezpośrednio. `!exit` lub przycisk 🚪 kończy sesję."
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

    const session = { history: [], lastActivity: Date.now(), proc: null };
    claudeSessions.set(thread.id, session);

    // Remote Control link — opens interactive Claude in browser (phone/PC)
    const serverIP = process.env.SERVER_IP
      || process.env.AGENT_URL?.match(/\/\/([\d.a-z-]+)/i)?.[1]?.replace(/:\d+$/, "")
      || "localhost";
    await thread.send({
      embeds: [new EmbedBuilder()
        .setColor(0x059669)
        .setTitle("📱 Remote Control — otwórz na telefonie")
        .setDescription(`**http://${serverIP}:7681**\nInteraktywny Claude w przeglądarce z pełnym dostępem do serwera.`)
        .setFooter({ text: "Każde połączenie = nowa sesja Claude · --dangerously-skip-permissions aktywne" })
      ],
    });

    await thread.send({
      embeds: [new EmbedBuilder()
        .setColor(0x6366f1)
        .setTitle("🤖 Sesja Claude Code")
        .setDescription(
          "• Pisz bezpośrednio — każda wiadomość trafia do Claude\n" +
          "• Widoczne: 💭 myślenie · 🔧 narzędzia · 📤 wyniki · 💰 koszt\n" +
          "• `!exit` lub przycisk **🚪 Zakończ** — zamknij sesję"
        )
        .setFooter({ text: `Skip-permissions aktywny · Wygasa po ${SESSION_TIMEOUT / 60000}min nieaktywności` })
      ],
      components: [controlRow()],
    });

    await thread.sendTyping();
    const typing = setInterval(() => thread.sendTyping(), 8000);
    try {
      const result = await streamClaudeToThread(thread, initialPrompt, session);
      clearInterval(typing);
      session.history.push({ role: "user", content: initialPrompt });
      session.history.push({ role: "assistant", content: result.response });
      session.lastActivity = Date.now();
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
          "`!claude <prompt>` — otwiera wątek z pełnym UI Claude CLI",
          "W wątku: pisz bezpośrednio | przyciski: ⏹ Stop 🔄 Wyczyść 🚪 Zakończ",
          "Widać: 💭 myślenie · 🔧 narzędzia · 📤 wyniki · 💰 koszt",
        ].join("\n"), inline: false },
      )
      .setFooter({ text: `Bot: ${process.env.AGENT_URL?.replace("http://", "").split(":")[0] || "localhost"}` });
    await msg.channel.send({ embeds: [embed] });
  },
};

// ── Button interaction handler ────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("claude_")) return;

  const session = claudeSessions.get(interaction.channelId);
  if (!session) {
    return interaction.reply({ content: "❌ Brak aktywnej sesji.", ephemeral: true });
  }

  if (interaction.customId === "claude_stop") {
    if (session.proc) {
      session.proc.kill();
      session.proc = null;
      await interaction.reply({ content: "⏹ Zatrzymano aktywny proces Claude.", ephemeral: true });
    } else {
      await interaction.reply({ content: "ℹ️ Brak aktywnego procesu.", ephemeral: true });
    }

  } else if (interaction.customId === "claude_clear") {
    session.history = [];
    await interaction.reply({ content: "🔄 Historia rozmowy wyczyszczona.", ephemeral: true });

  } else if (interaction.customId === "claude_exit") {
    if (session.proc) session.proc.kill();
    claudeSessions.delete(interaction.channelId);
    await interaction.reply({ content: "👋 Sesja Claude zakończona." });
    try { await interaction.channel.setArchived(true); } catch {}
  }
});

// ── Message handler ───────────────────────────────────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  // Handle messages inside an active Claude session thread
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
    await msg.channel.sendTyping();
    const typing = setInterval(() => msg.channel.sendTyping(), 8000);
    try {
      const fullPrompt = buildPromptWithHistory(session.history, msg.content);
      const result = await streamClaudeToThread(msg.channel, fullPrompt, session);
      clearInterval(typing);
      session.history.push({ role: "user", content: msg.content });
      session.history.push({ role: "assistant", content: result.response });
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
