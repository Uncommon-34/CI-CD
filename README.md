# Webhook-Driven Deploy Runner

A self-contained Docker image that automatically deploys a Node.js application from GitHub whenever you push to your repository. It listens for GitHub webhooks, verifies signatures, pulls the latest code, rebuilds, and restarts your app—all with zero downtime on build failures.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Developer pushes to GitHub                                      │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  GitHub sends POST to /webhook with HMAC signature              │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Container verifies signature with timing-safe compare          │
│  (rejects with 401 if invalid)                                  │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Responds immediately (202) so GitHub doesn't timeout           │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Deploy runs asynchronously in background                       │
│  1. git fetch & reset to latest commit                          │
│  2. npm ci (or npm install if no lockfile)                      │
│  3. npm run build                                               │
│  4. Send SIGTERM to old app, wait 10s, then SIGKILL if needed   │
│  5. npm run start (new app)                                     │
└────────────────────┬────────────────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
         ▼                       ▼
    ✓ Build succeeds       ✗ Build fails
         │                       │
         ▼                       ▼
    Restart app          Keep running app up
    Max 1 deploy queued   Log error clearly
```

## Quick Start

### Prerequisites
- Docker and Docker Compose on Ubuntu (or any Linux host)
- A GitHub repository with a Node.js app that has `npm run build` and `npm run start` scripts
- For private repos: a GitHub fine-grained personal access token

### 1. Clone or copy these files to your server

```bash
git clone <this-repo> deploy-runner
cd deploy-runner
```

### 2. Generate a webhook secret

```bash
openssl rand -hex 32
```

Copy the output (e.g., `a3f2c8e1d4b9c5f7a2e8d1b4c7f0a3e5d2b8c1f4a7e0d3c6b9f2e5a8d1c4b7`)

### 3. Create your `.env` file

```bash
cp .env.example .env
```

Edit `.env` with your GitHub repo and webhook secret:

```env
REPO_URL=https://github.com/user/repo
GITHUB_TOKEN=github_pat_... (only for private repos)
WEBHOOK_SECRET=a3f2c8e1d4b9c5f7a2e8d1b4c7f0a3e5d2b8c1f4a7e0d3c6b9f2e5a8d1c4b7
BRANCH=main
NODE_ENV=production
```

### 4. Build and start

```bash
docker-compose up -d
```

Check the logs:

```bash
docker-compose logs -f
```

### 5. Set up the webhook in GitHub

See **[Setting Up the GitHub Webhook](#setting-up-the-github-webhook)** below.

### 6. Make the server reachable

See **[Making Your Server Reachable](#making-your-server-reachable)** below.

### 7. Test it

See **[Testing](#testing)** below.

---

## Environment Variables

| Variable | Default | Required | Notes |
|----------|---------|----------|-------|
| `REPO_URL` | — | **Yes** | HTTPS GitHub URL, e.g. `https://github.com/user/repo` |
| `BRANCH` | `main` | No | Which branch to deploy |
| `GITHUB_TOKEN` | — | No* | Fine-grained PAT for **private repos only** (public repos don't need it) |
| `WEBHOOK_SECRET` | — | **Yes** | Secret for HMAC-SHA256 signature verification |
| `WEBHOOK_PORT` | `9000` | No | Port the webhook listener runs on |
| `NODE_ENV` | `production` | No | Passed to your app |

\* Public repos don't need `GITHUB_TOKEN`. For private repos, see **[GitHub Token Setup](#github-token-setup)** below.

Any other environment variables (e.g., `API_KEY`, `DATABASE_URL`) can be added to your `.env` file and will be passed through to your app at runtime.

---

## GitHub Token Setup

Only needed for **private repositories**. Public repos work without a token.

### Creating a Fine-Grained Personal Access Token

1. **Go to GitHub Settings**
   - Click your profile picture → **Settings**
   - Left sidebar → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**

2. **Create a new token**
   - Click **Generate new token**
   - Name: `deploy-runner` (or whatever you prefer)
   - Expiration: **30 days** (or longer; GitHub recommends short rotations, but 30–90 days is typical for automation)
   - Repository access: Select **Only select repositories** → pick your repo
   - Permissions: Scroll to **Repository permissions** → set **Contents** to **Read-only**
   - Click **Generate token**

3. **Copy the token**
   - You'll see a long string starting with `github_pat_...`
   - Copy it immediately (you can't see it again)

4. **Add to `.env`**
   ```env
   GITHUB_TOKEN=github_pat_...your_token_here...
   ```

5. **Rotating the token**
   - GitHub sends an email a few days before expiry
   - Generate a new token, update `.env`, restart: `docker-compose up -d`

---

## Generating a Webhook Secret

Use OpenSSL to create a strong 32-byte hex string:

```bash
openssl rand -hex 32
```

Example output:
```
a3f2c8e1d4b9c5f7a2e8d1b4c7f0a3e5d2b8c1f4a7e0d3c6b9f2e5a8d1c4b7
```

Add to `.env`:
```env
WEBHOOK_SECRET=a3f2c8e1d4b9c5f7a2e8d1b4c7f0a3e5d2b8c1f4a7e0d3c6b9f2e5a8d1c4b7
```

---

## Setting Up the GitHub Webhook

### In the GitHub web UI

1. **Go to your repo**
   - **Settings** tab (top right)
   - Left sidebar → **Webhooks**

2. **Add webhook**
   - Click **Add webhook**
   - **Payload URL**: `http://<your-server-ip>:9000/webhook`  
     (Replace `<your-server-ip>` with your server's public IP or domain; e.g., `http://192.168.1.100:9000/webhook` or `https://deploy.example.com/webhook`)
   - **Content type**: `application/json`
   - **Secret**: Paste the webhook secret you generated above
   - **Events**: Select **Just the push event**
   - ✓ **Active** (should be checked)
   - Click **Add webhook**

3. **Test it** (GitHub's UI will show recent deliveries)
   - Scroll to the bottom of the newly created webhook
   - Click **Recent Deliveries**
   - You should see your test delivery (green ✓ if working, or error details if not)

---

## Making Your Server Reachable

GitHub needs to reach your server's webhook endpoint (`http://<your-server>:9000/webhook`).

### Option A: Port Forwarding (Simple but Less Secure)

1. **Log into your router**
   - Find your router's IP (usually `192.168.1.1` or `192.168.0.1`)
   - Log in with admin credentials

2. **Port forward**
   - Look for **Port Forwarding** (may be under NAT, Firewall, or Advanced settings)
   - Forward external port `9000` to your Ubuntu machine's internal IP on port `9000`
   - Example: External `9000` → Internal `192.168.1.50:9000`

3. **Find your public IP**
   ```bash
   curl ifconfig.me
   ```
   - Use this IP in the GitHub webhook: `http://<public-ip>:9000/webhook`

4. **Caveats**
   - Your ISP may block port `9000` (or all non-HTTP ports)
   - Your public IP may change (use a dynamic DNS service if it does)
   - Port `9000` is exposed directly to the internet (less secure)

### Option B: Cloudflare Tunnel (Recommended)

Securer and doesn't require port forwarding. Works even behind restrictive firewalls.

1. **Create a Cloudflare Tunnel**
   - Go to [Cloudflare Tunnels](https://dash.cloudflare.com/sign-up/account/tunnels)
   - Click **Create a tunnel**, choose **Cloudflared**
   - Name: `deploy-runner`
   - Install `cloudflared` on your server:
     ```bash
     curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
     sudo dpkg -i cloudflared.deb
     ```

2. **Connect the tunnel**
   - Run the command Cloudflare gives you (it will authenticate):
     ```bash
     cloudflared tunnel login
     cloudflared tunnel run <tunnel-name>
     ```
   - Keep this running (or use the daemon: `cloudflared tunnel install && cloudflared tunnel start`)

3. **Route the webhook**
   - In the Cloudflare dashboard, under your tunnel:
     - **Public hostname**: `deploy.example.com` (or any subdomain)
     - **Service**: `http://localhost:9000`
   - Save

4. **Update the webhook in GitHub**
   - Payload URL: `https://deploy.example.com/webhook` (use the subdomain)

5. **Benefits**
   - No port forwarding needed
   - HTTPS by default (Cloudflare provides TLS)
   - Private IP stays private
   - Works everywhere (even on residential ISPs)

---

## Testing

### Manual test with curl

Generate a test payload and sign it:

```bash
#!/bin/bash

WEBHOOK_SECRET="your-webhook-secret-here"
WEBHOOK_URL="http://localhost:9000/webhook"  # or your public URL

# Create a simple push payload (GitHub format)
PAYLOAD='{
  "ref": "refs/heads/main",
  "before": "abc123",
  "after": "def456",
  "repository": {
    "name": "my-repo",
    "full_name": "user/my-repo",
    "url": "https://github.com/user/my-repo"
  },
  "pusher": {
    "name": "testuser"
  }
}'

# Sign it with the webhook secret (same algorithm GitHub uses)
SIGNATURE="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')"

# Send the webhook
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  -H "X-GitHub-Event: push" \
  -d "$PAYLOAD" \
  "$WEBHOOK_URL"
```

Expected response: `202 Accepted` (deploy is queued)

Then check:

```bash
# View logs
docker-compose logs -f

# Check health
curl http://localhost:9000/health
```

Health response example:
```json
{
  "status": "idle",
  "commitSha": "def456abc123",
  "lastDeployTime": "2025-10-16T12:34:56.789Z",
  "uptime": 3600
}
```

### Test in GitHub UI

1. **Push to the configured branch**
   - Make a commit and `git push`

2. **Check Recent Deliveries**
   - Go to your webhook in GitHub repo Settings → Webhooks
   - Click the webhook, scroll to **Recent Deliveries**
   - You should see the push event with a green ✓

3. **Check the app**
   - If the app runs on port 3000: `curl http://localhost:3000`
   - Check `docker-compose logs -f` for any errors

---

## Logs and Monitoring

### View logs

```bash
# Real-time logs
docker-compose logs -f

# Last 100 lines
docker-compose logs --tail=100

# Just the container
docker logs -f <container-id>
```

Log entries are prefixed:
- `[webhook]` — webhook events and signature verification
- `[deploy]` — deployment steps (fetch, build, restart)
- `[app]` — app startup and crashes
- `[init]` — initialization
- `[shutdown]` — graceful shutdown

Example logs:
```
2025-10-16T12:34:56.789Z [webhook] Server listening on port 9000
2025-10-16T12:35:10.123Z [webhook] Received push to main
2025-10-16T12:35:10.234Z [deploy] Starting deploy
2025-10-16T12:35:15.456Z [deploy] Checked out commit abc123def456
2025-10-16T12:35:20.789Z [deploy] Running npm ci
2025-10-16T12:35:45.012Z [deploy] Running npm run build
2025-10-16T12:36:00.345Z [deploy] Build succeeded, restarting app
2025-10-16T12:36:00.567Z [app] Stopping PID 45 with SIGTERM
2025-10-16T12:36:01.890Z [app] Starting app with npm run start
```

### Health check endpoint

```bash
curl http://localhost:9000/health
```

Status values:
- `idle` — not currently deploying
- `deploying` — build/deploy in progress
- `failed` — last build failed (but app is still running)

The container's `docker-compose healthcheck` also queries this endpoint every 30 seconds.

---

## Troubleshooting

### Signature Mismatch / 401 Unauthorized

**Symptom:** Recent Deliveries shows `401 Unauthorized`

**Causes:**
- Webhook secret in GitHub doesn't match `WEBHOOK_SECRET` in `.env`
- Secret was changed but not synced between GitHub and container
- Webhook payload was modified in transit (very rare)

**Fix:**
1. Verify the secret in GitHub matches your `.env`:
   ```bash
   grep WEBHOOK_SECRET .env
   ```
2. In GitHub, edit the webhook and confirm the secret matches
3. Restart the container:
   ```bash
   docker-compose restart
   ```

### Auth Failure on Clone / Cannot Read Repository

**Symptom:** Logs show `fatal: Authentication failed` or `permission denied`

**Causes:**
- Private repo but no `GITHUB_TOKEN` set
- Token expired or was revoked
- Token doesn't have read access to this repo

**Fix:**
1. For **public repos**: no token needed; check that `REPO_URL` is correct
2. For **private repos**:
   - Generate a new fine-grained token (see **[GitHub Token Setup](#github-token-setup)**)
   - Update `.env`: `GITHUB_TOKEN=github_pat_...`
   - Restart: `docker-compose down && docker-compose up -d`
3. Verify the token has **Contents: Read-only** permission for your repo

### Build Fails / Cannot Find Script

**Symptom:** Logs show `npm ERR! missing script: build`

**Causes:**
- Your `package.json` doesn't have a `build` script
- `npm ci` or `npm install` failed (check for dependency errors)

**Fix:**
1. Add a `build` script to `package.json` if missing:
   ```json
   {
     "scripts": {
       "build": "your-build-command",
       "start": "your-start-command"
     }
   }
   ```
2. Check `docker-compose logs` for `npm` errors
3. If stuck, test locally:
   ```bash
   npm ci && npm run build
   ```

### Build Fails But App Keeps Running

This is **intentional**. The deploy runner does not stop the old app if the new build fails. 

**Why:** Avoid downtime; if your new code has a bug, the old version stays live while you fix it.

**What to do:**
1. Check the logs: `docker-compose logs | grep "Build failed"`
2. Fix the error in your code
3. Push again; the deploy will retry automatically

### App Doesn't Start After Deploy

**Symptom:** Deploy says "succeeded" but app doesn't respond

**Causes:**
- `npm run start` requires an argument or config the container doesn't have
- App binds to the wrong port
- Missing environment variables

**Fix:**
1. Check the `package.json` start script:
   ```bash
   cat package.json | grep '"start"'
   ```
   Should be something like `"node index.js"` or `"npm start"` (avoid daemonizing; Docker stops daemonized processes)

2. Ensure your app listens on a port and logs it:
   - The container publishes port 3000 by default (edit `docker-compose.yml` if your app uses a different port)
   - Logs should say `Listening on port 3000` or similar

3. Add missing env vars to `.env` and restart:
   ```bash
   docker-compose down && docker-compose up -d
   ```

### Server Not Reachable / GitHub Can't Send Webhook

**Symptom:** GitHub shows `Unable to reach your server` or `Connection timeout`

**Causes:**
- Wrong IP or hostname in GitHub webhook settings
- Port 9000 not forwarded (if using port forwarding)
- Firewall blocking port 9000
- Cloudflare Tunnel not running

**Fix (Port Forwarding):**
1. Confirm your public IP:
   ```bash
   curl ifconfig.me
   ```
2. Update GitHub webhook to `http://<your-public-ip>:9000/webhook`
3. Test reachability from outside:
   ```bash
   curl http://<your-public-ip>:9000/health
   ```

**Fix (Cloudflare Tunnel):**
1. Ensure tunnel is running:
   ```bash
   cloudflared tunnel list
   ```
2. Test the subdomain:
   ```bash
   curl https://deploy.example.com/health
   ```
3. Restart tunnel if needed:
   ```bash
   cloudflared tunnel stop <tunnel-name>
   cloudflared tunnel run <tunnel-name>
   ```

### Deployment Queuing / Slow Deploy

**Symptom:** Multiple pushes within seconds show only one deploy in the logs

This is **intentional**. Only one deploy runs at a time; additional pushes queue one follow-up. This prevents parallel builds and resource exhaustion.

**What's happening:**
1. Push 1 → deploy starts
2. Push 2 (while deploy 1 is running) → queued
3. Push 3 (while deploy 1 is running) → ignored (already have one queued)
4. Deploy 1 finishes → deploy 2 starts automatically
5. Deploy 2 finishes → done

See the logs for `Deploying queued follow-up`.

### Port Already in Use

**Symptom:** `docker-compose up` fails with `bind: address already in use`

**Fix:**
1. Find what's using the port:
   ```bash
   sudo lsof -i :9000
   # or
   sudo netstat -tuln | grep 9000
   ```
2. Either:
   - Stop the other service
   - Change the webhook port in `.env`: `WEBHOOK_PORT=9001`
   - Change the port mapping in `docker-compose.yml`: `"9001:9000"`

---

## Architecture & Features

### Key Design Decisions

- **Plain Node `http` module** — no Express or frameworks; minimal dependencies
- **Timing-safe HMAC comparison** — uses `crypto.timingSafeEqual` to prevent timing attacks
- **Async webhook response (202)** — GitHub gets immediate response; deploy runs in background
- **Single-queue deploy system** — max 1 queued deploy; prevents resource exhaustion
- **Graceful failures** — build failures don't stop the running app
- **Process management** — SIGTERM → wait 10s → SIGKILL ensures clean restarts
- **Auto-restart on crash** — if the app dies outside a deploy, it restarts with 5s backoff
- **Commit SHA tracking** — `/health` endpoint shows what's deployed and when

### Env Var Security

- `GITHUB_TOKEN` is **never** logged, even on error (logs call `scrubToken()` to redact it)
- Webhook secret is only used for verification; never logged
- All error messages are passed through `scrubToken()` before logging

---

## Next Steps

1. **Deploy to your Ubuntu server** (adjust for your environment)
2. **Test a real push** to confirm the webhook fires
3. **Monitor `/health`** or logs to ensure deploys are working
4. **Rotate your GitHub token** every 30–90 days
5. **Set up monitoring/alerting** on the `/health` endpoint if desired

---

## License

Use as-is. Modify for your needs.
