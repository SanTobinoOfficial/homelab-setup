require("dotenv").config();
const express = require("express");
const path = require("path");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;
const LAPTOP_IP = process.env.LAPTOP_IP || "192.168.1.100";
const AGENT_API_KEY = process.env.AGENT_API_KEY || "";
const AGENT_URL = `http://${LAPTOP_IP}:9090`;
const PIHOLE_URL = `http://${LAPTOP_IP}:8053`;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function httpGet(url, headers = {}, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: "GET",
      headers,
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

async function agentRequest(endpoint, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(AGENT_URL + endpoint);
    const options = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method,
      headers: { "X-API-Key": AGENT_API_KEY, "Content-Type": "application/json" },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

app.get("/api/status", async (req, res) => {
  try {
    const [metrics, services, storage] = await Promise.all([
      agentRequest("/api/metrics"),
      agentRequest("/api/services"),
      agentRequest("/api/storage"),
    ]);
    res.json({ online: true, metrics: metrics.data, services: services.data, storage: storage.data });
  } catch (e) {
    res.json({ online: false, error: e.message });
  }
});

app.get("/api/pihole", async (req, res) => {
  try {
    const r = await httpGet(`${PIHOLE_URL}/admin/api.php?summaryRaw`, {}, 5000);
    res.json({ online: true, ...r.data });
  } catch (e) {
    res.json({ online: false, error: e.message });
  }
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
  res.json({ laptop_ip: LAPTOP_IP, agent_url: AGENT_URL, pihole_url: PIHOLE_URL });
});

app.listen(PORT, () => {
  console.log(`\n HomeLab Admin Dashboard`);
  console.log(` URL:       http://localhost:${PORT}`);
  console.log(` Laptop:    ${LAPTOP_IP}`);
  console.log(` Agent:     ${AGENT_URL}`);
  console.log(` Pi-hole:   ${PIHOLE_URL}`);
  console.log(` API Key:   ${AGENT_API_KEY ? "configured" : "MISSING"}\n`);
});