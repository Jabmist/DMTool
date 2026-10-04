# nginx config — Obsidian at `/notes/` (live on `.201`)

Snapshot of the production nginx configuration (nginx 1.18.0) taken from
`192.168.1.201:/etc/nginx/sites-enabled/littlehillservices.com` on 2026-09-09.
This is the canonical reference for the `/notes/` routing; `nginx/obsidian.conf`
in this repo is a generic single-box sample and is **not** the live config.

## Context (from `/etc/nginx/nginx.conf`)

```nginx
user www-data;
worker_processes auto;
events { worker_connections 768; }
http {
	# Auth rate-limit zone (declared in nginx.conf http context, NOT in the site file):
	limit_req_zone $binary_remote_addr zone=obsidian_auth:10m rate=20r/m;
	...
}
```

## Site config (relevant parts)

The site is one server block for `littlehillservices.com` /
`www.littlehillservices.com`. HTTP :80 301-redirects to
`https://www.littlehillservices.com$request_uri`. The HTTPS server block has
`root /var/www/littlehillservices.com/public;` and `index index.php;` for the
main site (whose `location /` proxies to `192.168.1.202`) — but the `/notes/`
locations below use their own explicit `root /var/www` + `try_files`, so
`/notes/` files resolve from `/var/www/notes/...` regardless of the
server-level root.

```nginx
# ── Obsidian at /notes/ ──────────────────────────────────────────────
		location = /notes {
		return 301 /notes/;
	}
	location ^~ /notes/ws {
		proxy_pass http://192.168.1.202:3000/ws;
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection "upgrade";
		proxy_set_header Host $host;
		proxy_set_header X-Real-IP $remote_addr;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_read_timeout 86400s;
	}
	location ^~ /notes/api/auth/ {
		limit_req zone=obsidian_auth burst=5 nodelay;
		proxy_pass http://192.168.1.202:3000/api/auth/;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_set_header X-Real-IP $remote_addr;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
	}
	location ^~ /notes/api/ {
		proxy_pass http://192.168.1.202:3000/api/;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_set_header X-Real-IP $remote_addr;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
		client_max_body_size 55m;
	}
	location ^~ /notes/ {
		root /var/www;
		index index.html;
		try_files $uri $uri/ /notes/index.html;
	}
```

## Routing semantics

- `^~` prefix match — so `/notes/...` never falls through to the main site's
  `location /`, and `location /notes/ws` / `/notes/api/` win over the static
  `/notes/` location.
- `/notes` (no slash) → 301 → `/notes/`.
- `/notes/ws` → `192.168.1.202:3000/ws` with upgrade headers and a 24 h
  read timeout (long-lived WebSocket). Note: the proxy strips the `/notes`
  prefix — `proxy_pass` with a URI rewrites the path.
- `/notes/api/auth/*` → rate limited (`obsidian_auth`, 20r/m, burst 5) then
  proxied to `192.168.1.202:3000/api/auth/*`.
- `/notes/api/*` → proxied, `client_max_body_size 55m` (zip uploads).
- Everything else under `/notes/` → static from `/var/www/notes/`
  (`root /var/www` + URI = `/notes/...`), SPA fallback to `/notes/index.html`.

## Client build invariant (why `/notes/` matters)

Vite `base: '/notes/'` (see `client/vite.config.js`) makes built asset URLs
`/notes/assets/...`. If that regresses to `/assets/...`, the static location
above still serves `/notes/index.html` (try_files) but the JS bundle 404s.
Sanity check after any deploy:

```bash
grep -o 'notes/assets/index-[A-Za-z0-9_-]*\.js' /var/www/notes/index.html
```

## Verification checklist

See `handoff2.md` → "Verification checklist" (slash-less 301, static 200,
asset 200, API 400, WS 101).
