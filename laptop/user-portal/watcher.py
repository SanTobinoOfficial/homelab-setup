#!/usr/bin/env python3
"""
HomeLab Network Watcher
Monitors ARP table for new devices, triggers captive portal redirect via iptables,
and sends Discord notification when unknown device connects.
"""
import subprocess
import json
import os
import time
import urllib.request
import urllib.parse

DEVICES_FILE = "/mnt/ssd/portal/devices.json"
KNOWN_MACS_FILE = "/mnt/ssd/portal/known_macs.txt"
PORTAL_PORT = 8888
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "")
CHECK_INTERVAL = 15  # seconds


def load_devices():
    try:
        with open(DEVICES_FILE) as f:
            return json.load(f)
    except Exception:
        return {"devices": []}


def get_known_macs():
    try:
        with open(KNOWN_MACS_FILE) as f:
            return set(line.strip().lower() for line in f if line.strip())
    except Exception:
        return set()


def save_known_mac(mac):
    with open(KNOWN_MACS_FILE, "a") as f:
        f.write(mac.lower() + "\n")


def get_arp_table():
    """Returns list of {ip, mac, iface} from ARP table."""
    try:
        result = subprocess.run(
            ["ip", "neigh", "show"],
            capture_output=True, text=True
        )
        entries = []
        for line in result.stdout.strip().split("\n"):
            parts = line.split()
            if len(parts) >= 5 and parts[2] == "lladdr":
                ip = parts[0]
                mac = parts[4].lower()
                iface = parts[2] if len(parts) > 2 else ""
                if not ip.startswith("169.") and mac != "ff:ff:ff:ff:ff:ff":
                    entries.append({"ip": ip, "mac": mac})
        return entries
    except Exception:
        return []


def find_device_by_mac(mac, devices):
    for d in devices.get("devices", []):
        if d.get("mac", "").lower() == mac.lower():
            return d
    return None


def add_iptables_redirect(ip):
    """Redirect HTTP from unknown device to captive portal."""
    try:
        # Check if rule already exists
        check = subprocess.run(
            ["iptables", "-t", "nat", "-C", "PREROUTING",
             "-s", ip, "-p", "tcp", "--dport", "80",
             "-j", "REDIRECT", "--to-port", str(PORTAL_PORT)],
            capture_output=True
        )
        if check.returncode != 0:
            subprocess.run(
                ["iptables", "-t", "nat", "-A", "PREROUTING",
                 "-s", ip, "-p", "tcp", "--dport", "80",
                 "-j", "REDIRECT", "--to-port", str(PORTAL_PORT)],
                capture_output=True
            )
    except Exception as e:
        print(f"[Watcher] iptables error for {ip}: {e}")


def remove_iptables_redirect(ip):
    """Remove captive portal redirect once device is registered."""
    try:
        subprocess.run(
            ["iptables", "-t", "nat", "-D", "PREROUTING",
             "-s", ip, "-p", "tcp", "--dport", "80",
             "-j", "REDIRECT", "--to-port", str(PORTAL_PORT)],
            capture_output=True
        )
    except Exception:
        pass


def send_discord_notification(ip, mac):
    if not DISCORD_WEBHOOK:
        return
    try:
        payload = json.dumps({
            "embeds": [{
                "title": "🆕 Nowe urządzenie w sieci",
                "color": 0xf59e0b,
                "fields": [
                    {"name": "IP", "value": ip, "inline": True},
                    {"name": "MAC", "value": mac, "inline": True},
                ],
                "description": f"Nieznane urządzenie dołączyło do sieci.\nPortal: http://{ip}:8888\n\nUżyj `!run python3 /opt/homelab/user-portal/watcher.py assign {mac} <rola> <nazwa>` żeby przypisać rolę.",
                "footer": {"text": "HomeLab Network Watcher"}
            }]
        }).encode()
        req = urllib.request.Request(
            DISCORD_WEBHOOK,
            data=payload,
            headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f"[Watcher] Discord notify error: {e}")


def assign_device(mac, role, name):
    """CLI helper: assign role to device by MAC."""
    data = load_devices()
    for d in data["devices"]:
        if d.get("mac", "").lower() == mac.lower():
            d["role"] = role
            d["name"] = name
            break
    else:
        data["devices"].append({
            "mac": mac.lower(),
            "name": name,
            "role": role,
            "registered": time.strftime("%Y-%m-%d")
        })
    with open(DEVICES_FILE, "w") as f:
        json.dump(data, f, indent=2)
    save_known_mac(mac)
    print(f"[Watcher] Assigned {mac} → {role} ({name})")


def main_loop():
    os.makedirs(os.path.dirname(DEVICES_FILE), exist_ok=True)
    if not os.path.exists(DEVICES_FILE):
        with open(DEVICES_FILE, "w") as f:
            json.dump({"devices": []}, f)

    print("[Watcher] Starting network monitor...")
    seen_unknown = set()

    while True:
        devices_db = load_devices()
        known_macs = get_known_macs()
        arp_entries = get_arp_table()

        for entry in arp_entries:
            ip, mac = entry["ip"], entry["mac"]
            device = find_device_by_mac(mac, devices_db)

            if device:
                # Known device — remove redirect if it exists
                remove_iptables_redirect(ip)
                seen_unknown.discard(mac)
            else:
                # Unknown device — redirect to portal
                add_iptables_redirect(ip)
                if mac not in seen_unknown:
                    seen_unknown.add(mac)
                    print(f"[Watcher] Unknown device: {ip} ({mac}) — redirecting to portal")
                    send_discord_notification(ip, mac)

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 4 and sys.argv[1] == "assign":
        assign_device(sys.argv[2], sys.argv[3], " ".join(sys.argv[4:]) if len(sys.argv) > 4 else "Unnamed")
    else:
        main_loop()
