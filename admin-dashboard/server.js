require("dotenv").config();
const express = require("express");
const path = require("path");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;
const LAPTOP_IP = process.env.LAPTOP_IP || "192.168.1.100";
const AGENT_API_KEY = process.env.AGENT_API_KEY || "";
const PIHOLE_PASSWORD = process.env.PIHOLE_PASSWORD || "admin";
const AGENT_URL = `http://${LAPTOP_IP}:9090`;
const PIHOLE_URL = `http://${LAPTOP_IP}:8053`;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let piholeSession = null;
let piholeSessionExpiry = 0;

async function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const options = {
      hostname: u.hostname, port: u.port || 80,
      path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
    };
    const req = http.request(options, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, data: d }); } });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(data); req.end();
  });
}

async function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: "GET", headers };
    const req = http.request(options, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, data: d }); } });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

async function agentRequest(endpoint, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(AGENT_URL + endpoint);
    const options = { hostname: u.hostname, port: u.port || 80, path: u.pathname, method,
      headers: { "X-API-Key": AGENT_API_KEY, "Content-Type": "application/json" } };
    const req = http.request(options, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, data: d }); } });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getPiholeSession() {
  if (piholeSession && Date.now() < piholeSessionExpiry) return piholeSession;
  try {
    const r = await httpPost(`${PIHOLE_URL}/api/auth`, { password: PIHOLE_PASSWORD });
    if (r.data?.session?.sid) {
      piholeSession = r.data.session.sid;
      piholeSessionExpiry = Date.now() + (r.data.session.validity || 290) * 1000;
      return piholeSession;
    }
  } catch (e) {}
  return null;
}

app.get("/api/status", async (req, res) => {
  try {
    const [metrics, services, storage] = await Promise.all([
      agentRequest("/api/metrics"), agentRequest("/api/services"), agentRequest("/api/storage"),
    ]);
    res.json({ online: true, metrics: metrics.data, services: services.data, storage: storage.data });
  } catch (e) { res.json({ online: false, error: e.message }); }
});

app.get("/api/pihole", async (req, res) => {
  try {
    const sid = await getPiholeSession();
    if (!sid) { res.json({ online: false, error: "auth failed" }); return; }
    const r = await httpGet(`${PIHOLE_URL}/api/stats/summary?sid=${sid}`);
    if (r.status === 200 && r.data?.queries) {
      const d = r.data;
      res.json({
        online: true,
        dns_queries_today: d.queries?.total || 0,
        ads_blocked_today: d.queries?.blocked || 0,
        ads_percentage_today: d.queries?.percent_blocked || 0,
        domains_being_blocked: d.gravity?.domains_being_blocked || 0,
      });
    } else {
      res.json({ online: false, error: `status ${r.status}` });
    }
  } catch (e) { res.json({ online: false, error: e.message }); }
});

app.get("/api/metrics", async (req, res) => {
  try { const r = await agentRequest("/api/metrics"); res.json(r.data); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get("/api/services", async (req, res) => {
  try { const r = await agentRequest("/api/services"); res.json(r.data); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get("/api/logs/:service", async (req, res) => {
  try { const r = await agentRequest(`/api/logs/${req.params.service}`); res.json(r.data); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.post("/api/services/restart", async (req, res) => {
  try { const r = await agentRequest("/api/services/restart", "POST", req.body); res.json(r.data); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.post("/api/services/stop", async (req, res) => {
  try { const r = await agentRequest("/api/services/stop", "POST", req.body); res.json(r.data); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get("/api/storage", async (req, res) => {
  try { const r = await agentRequest("/api/storage"); res.json(r.data); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get("/api/config", (req, res) => {
  res.json({ laptop_ip: LAPTOP_IP, agent_url: AGENT_URL, terminal_url: `http://${LAPTOP_IP}:7681` });
});

app.listen(PORT, () => {
  console.log(`\n HomeLab Admin Dashboard`);
  console.log(` URL:       http://localhost:${PORT}`);
  console.log(` Laptop:    ${LAPTOP_IP}`);
  console.log(` Agent:     ${AGENT_URL}`);
  console.log(` Terminal:  http://${LAPTOP_IP}:7681`);
  console.log(` API Key:   ${AGENT_API_KEY ? "configured" : "MISSING"}\n`);
});