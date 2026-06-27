# Deploying Catan: Starfarers to Fly.io (always-on, paid)

This moves the game off Render's free tier to a small always-on Fly machine
(~$3–5/mo) so the server never sleeps and WebSockets stay connected. The repo
already has the `Dockerfile`, `.dockerignore`, and `fly.toml` it needs.

Everything here runs on **your** machine (Fly CLI, your card, your DNS). I can't
do these steps from inside the project — but they're copy‑paste.

---

## 1. Install the Fly CLI and log in
```bash
# macOS/Linux:
curl -L https://fly.io/install.sh | sh
# Windows (PowerShell):
#   pwsh -c "iwr https://fly.io/install.sh -useb | iex"

fly auth login        # opens the browser; add a card under Billing if prompted
```

## 2. Create the app (don't deploy yet)
```bash
cd "Catan Starfarers"
fly launch --no-deploy
```
- When asked, **reuse the existing `fly.toml`** (say No to "overwrite").
- Pick a unique **app name** (e.g. `starfarers-space`) — then set the same name as
  `app = "..."` at the top of `fly.toml`.
- Pick a **region** close to your players and set it as `primary_region` in
  `fly.toml`: `bom` (Mumbai, closest to the UAE), `fra` (Frankfurt), `cdg` (Paris),
  `iad` (US‑East).

## 3. Set the server secrets (env vars)
These are the same values you use on Render. The service_role key is **server‑only** —
never put it in the client build.
```bash
fly secrets set \
  SUPABASE_URL="https://YOUR-PROJECT.supabase.co" \
  SUPABASE_SERVICE_KEY="YOUR-SERVICE-ROLE-KEY" \
  ALLOWED_ORIGINS="https://starfarers.space,https://www.starfarers.space"
# optional: lock the /stats dashboard
# fly secrets set STATS_TOKEN="some-long-random-string"
```
> Until your domain is attached, also add the Fly URL to ALLOWED_ORIGINS for
> testing, e.g. `...,https://YOUR-APP.fly.dev`.

## 4. Deploy
```bash
fly deploy
```
First build takes a few minutes. When it finishes:
```bash
fly open            # opens https://YOUR-APP.fly.dev
fly logs            # watch it boot ("server running", persistence on)
```
Check `https://YOUR-APP.fly.dev/health` returns `{"ok":true}`, then play a quick
multiplayer game on the `.fly.dev` URL to confirm sockets stay connected.

## 5. Point your domain at Fly
```bash
fly certs add starfarers.space
fly certs add www.starfarers.space
```
Fly prints the exact DNS records to add at your registrar (an A + AAAA for the
apex, or a CNAME for `www`). Add them, wait for the cert to go green
(`fly certs show starfarers.space`), then your live site runs on Fly.

## 6. Final switch
- Make sure `ALLOWED_ORIGINS` lists your real domain(s).
- In Render, you can pause/suspend the old service once Fly is serving the domain.

---

## Why this fixes the disconnects
- `fly.toml` sets `auto_stop_machines = "off"` + `min_machines_running = 1`, so the
  box is **always on** — no spin‑down, no cold‑start rejoin.
- The recent client fix auto‑reconnects + re‑joins after any blip (including a
  server restart), and the server restores in‑progress games from Supabase — so
  `SUPABASE_SERVICE_KEY` (step 3) is what makes a restart seamless instead of
  forcing players to start over.

## Handy commands
```bash
fly status            # machine state
fly logs              # live logs
fly secrets list      # what's set (values hidden)
fly scale memory 1024 # bump to 1GB if ever needed (you won't for 4 players)
fly deploy            # redeploy after `git pull` / changes
```
