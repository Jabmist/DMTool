# Server Setup Guide

Tested base: Ubuntu 24.04 LTS / Debian 12. Commands assume a non-root sudo user.

---

## 1. System packages

```bash
sudo apt update && sudo apt upgrade -y

# Build tools required by better-sqlite3 and bcrypt (native Node addons)
sudo apt install -y build-essential python3 git curl

# nginx and certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# (Optional) firewall
sudo apt install -y ufw
```

---

## 2. Node.js 22 LTS

Do **not** use the distro's `apt` Node — it is too old, and it installs `libnode.so` as a shared library. If both the apt Node and nvm/NodeSource Node are installed simultaneously, native addons (better-sqlite3) will link against the apt `libnode.so` and segfault at runtime under the newer Node. If you previously installed Node via apt, remove it first:

```bash
sudo apt remove nodejs libnode-dev libnode109
sudo apt autoremove
```

Install via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # expect v22.x.x
npm --version    # expect 10.x.x
```

---

## 3. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # opens 80 and 443
sudo ufw enable
sudo ufw status
```

Port 3000 (Node) must **not** be open to the internet — nginx proxies to it internally.

---

## 4. Application user (recommended)

Run the app as a dedicated unprivileged user rather than your login user or root:

```bash
sudo useradd -r -m -s /bin/bash obsidian
sudo mkdir -p /opt/obsidian
sudo chown obsidian:obsidian /opt/obsidian
```

---

## 5. Clone and install

```bash
sudo -u obsidian git clone <your-repo-url> /opt/obsidian/app
cd /opt/obsidian/app
sudo -u obsidian npm install
```

`npm install` compiles `better-sqlite3` and `bcrypt` from source — this requires
`build-essential` and `python3` from step 1. Expect it to take 1-2 minutes.

`better-sqlite3` requires version 12.x or later for Node 22 (ABI 127). Version 11.x will segfault on load.

If Node is ever upgraded after the initial install, native addons must be rebuilt or the server will segfault on startup:

```bash
npm rebuild better-sqlite3 bcrypt
```

---

## 6. Environment

```bash
sudo -u obsidian cp /opt/obsidian/app/.env.example /opt/obsidian/app/.env
sudo -u obsidian nano /opt/obsidian/app/.env
```

Fill in every value. Generate secrets with:

```bash
openssl rand -hex 32   # paste as JWT_ACCESS_SECRET
openssl rand -hex 32   # paste as JWT_REFRESH_SECRET
```

Set paths to directories the `obsidian` user owns:

```
VAULT_ROOT=/opt/obsidian/data/vaults
UPLOAD_TMP=/opt/obsidian/data/uploads
DB_PATH=/opt/obsidian/data/obsidian.db
NODE_ENV=production
PORT=3000
```

Also set these non-path values:

```
CLIENT_ORIGIN=https://your.domain.com   # must match your public domain (used for CORS)
OLLAMA_BASE_URL=http://192.168.1.173:11434   # your Ollama server (required for AI note dissection)
OLLAMA_MODEL=gemini-gemma4:12b                 # pick a tool-capable model from that server
```

Create the data directories:

```bash
sudo -u obsidian mkdir -p /opt/obsidian/data/{vaults,uploads}
```

---

## 7. Build the client

```bash
cd /opt/obsidian/app
sudo -u obsidian npm run build   # outputs to client/dist
```

---

## 8. systemd service

```bash
sudo nano /etc/systemd/system/obsidian-web.service
```

```ini
[Unit]
Description=Obsidian Web
After=network.target

[Service]
Type=simple
User=obsidian
WorkingDirectory=/opt/obsidian/app
ExecStart=/usr/bin/node server/src/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/obsidian/app/.env

# Harden the process
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/obsidian/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable obsidian-web
sudo systemctl start obsidian-web
sudo systemctl status obsidian-web
```

---

## 9. TLS certificate

```bash
# Replace with your actual domain
sudo certbot --nginx -d your.domain.com
```

Certbot will auto-renew. Verify the timer:

```bash
sudo systemctl status certbot.timer
```

---

## 10. nginx

Edit the config to match your domain and paths:

```bash
sudo cp /opt/obsidian/app/nginx/obsidian.conf /etc/nginx/sites-available/obsidian
sudo nano /etc/nginx/sites-available/obsidian
```

Change every occurrence of `your.domain.com` to your real domain.
Update the `root` directive to point at the built client:

```nginx
root /opt/obsidian/app/client/dist;
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/obsidian /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 11. Verify

```bash
# Node server is up
sudo systemctl status obsidian-web

# nginx is proxying the API: expect HTTP 400 with a *JSON* body from the app
# (nginx's own 404 is an HTML page — a 400/JSON means the request reached Node)
curl -si -X POST https://your.domain.com/api/auth/login \
     -H 'Content-Type: application/json' -d '{}'
# → 400 { "error": "email and password required" }

# nginx is proxying the WebSocket route WITH upgrade headers: expect HTTP 101.
# (A plain GET/HEAD on /ws returns 404 — the server only answers the WS
#  upgrade handshake — so you must send the upgrade headers.)
curl -s -m 2 -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' \
  https://your.domain.com/ws
# → 101
```

---

## Updates

```bash
cd /opt/obsidian/app
sudo -u obsidian git pull
sudo -u obsidian npm install        # in case dependencies changed
sudo -u obsidian npm run build      # rebuild client
sudo systemctl restart obsidian-web
```

---

## Dev box vs production differences

| | Dev box (Linux Mint 22.3) | Production target |
|---|---|---|
| Node | 22.x (NodeSource / nvm) | 22 LTS (NodeSource) |
| npm | 10.9.x | 10.x.x |
| nginx | not installed | installed via apt |
| certbot | not installed | installed via apt |
| TLS | none (plain HTTP) | Let's Encrypt |
| Process manager | `npm run dev` (concurrently: `node --watch` + Vite) | systemd |
| Client | Vite dev server (:5173) | built static files served by nginx |
| .env | `.env` in project root | `/opt/obsidian/app/.env`, owned by `obsidian` user |
