#!/usr/bin/env python3
"""HomeLab Node Agent — REST API for Admin Dashboard"""
import os
import json
import subprocess
import shutil
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

API_KEY = os.environ.get("AGENT_API_KEY", "changeme")
PORT = 9090


def get_metrics():
    m = {}
    try:
        r = subprocess.run(["top", "-bn1"], capture_output=True, text=True)
        for line in r.stdout.split("\n"):
            if "Cpu(s)" in line or "%Cpu" in line:
                idle = float(line.split(",")[3].strip().split()[0])
                m["cpu_percent"] = round(100 - idle, 1)
                break
    except Exception:
        m["cpu_percent"] = 0

    try:
        with open("/proc/meminfo") as f:
            mem = {}
            for line in f:
                p = line.split()
                if len(p) >= 2:
                    mem[p[0].rstrip(":")] = int(p[1])
            total = mem.get("MemTotal", 1)
            avail = mem.get("MemAvailable", 0)
            used = total - avail
            m["ram_total_mb"] = total // 1024
            m["ram_used_mb"] = used // 1024
            m["ram_percent"] = round(used / total * 100, 1)
    except Exception:
        m["ram_total_mb"] = m["ram_used_mb"] = m["ram_percent"] = 0

    try:
        total, used, free = shutil.disk_usage("/mnt/ssd")
        m["disk_total_gb"] = round(total / 1024**3, 1)
        m["disk_used_gb"] = round(used / 1024**3, 1)
        m["disk_free_gb"] = round(free / 1024**3, 1)
        m["disk_percent"] = round(used / total * 100, 1)
    except Exception:
        m["disk_total_gb"] = m["disk_used_gb"] = m["disk_free_gb"] = m["disk_percent"] = 0

    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            m["temp_celsius"] = round(int(f.read().strip()) / 1000, 1)
    except Exception:
        m["temp_celsius"] = None

    try:
        with open("/proc/uptime") as f:
            m["uptime_seconds"] = int(float(f.read().split()[0]))
    except Exception:
        m["uptime_seconds"] = 0

    return m


def get_services():
    try:
        r = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{.Names}}|{{.Status}}|{{.Ports}}|{{.Image}}"],
            capture_output=True, text=True
        )
        services = []
        for line in r.stdout.strip().split("\n"):
            if not line:
                continue
            p = line.split("|")
            if len(p) >= 4:
                running = p[1].startswith("Up")
                services.append({
                    "name": p[0],
                    "status": "running" if running else "stopped",
                    "status_raw": p[1],
                    "ports": p[2],
                    "image": p[3],
                })
        return services
    except Exception as e:
        return [{"error": str(e)}]


def get_logs(service, lines=100):
    try:
        r = subprocess.run(
            ["docker", "logs", "--tail", str(lines), service],
            capture_output=True, text=True
        )
        return (r.stdout + r.stderr).split("\n")
    except Exception as e:
        return [str(e)]


def restart_service(service):
    try:
        r = subprocess.run(["docker", "restart", service], capture_output=True, text=True, timeout=30)
        return {"success": r.returncode == 0, "output": r.stdout}
    except Exception as e:
        return {"success": False, "error": str(e)}


def stop_service(service):
    try:
        r = subprocess.run(["docker", "stop", service], capture_output=True, text=True, timeout=30)
        return {"success": r.returncode == 0, "output": r.stdout}
    except Exception as e:
        return {"success": False, "error": str(e)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def auth(self):
        if self.headers.get("X-API-Key", "") != API_KEY:
            self._json({"error": "Unauthorized"}, 401)
            return False
        return True

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-API-Key, Content-Type")
        self.end_headers()

    def do_GET(self):
        if not self.auth():
            return
        path = urlparse(self.path).path
        if path == "/api/health":
            self._json({"status": "ok", "version": "1.0"})
        elif path == "/api/metrics":
            self._json(get_metrics())
        elif path == "/api/services":
            self._json(get_services())
        elif path.startswith("/api/logs/"):
            svc = path.split("/api/logs/")[1]
            self._json({"service": svc, "logs": get_logs(svc)})
        elif path == "/api/storage":
            m = get_metrics()
            self._json({k: m.get(k) for k in ["disk_total_gb", "disk_used_gb", "disk_free_gb", "disk_percent"]})
        else:
            self._json({"error": "Not found"}, 404)

    def do_POST(self):
        if not self.auth():
            return
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        svc = body.get("service", "")
        if path == "/api/services/restart":
            self._json(restart_service(svc) if svc else {"error": "Missing service"})
        elif path == "/api/services/stop":
            self._json(stop_service(svc) if svc else {"error": "Missing service"})
        else:
            self._json({"error": "Not found"}, 404)


if __name__ == "__main__":
    print(f"[Agent] Starting on :{PORT}")
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
