# twilio-wa-relay — Operations Guide

## What This System Does

This is a WhatsApp message router. When someone sends a WhatsApp message to your Twilio number, Twilio forwards it here. This system:

1. Receives the message at `POST /webhook`
2. Validates that it really came from Twilio (signature check)
3. Stores the raw message in SQLite (permanent audit trail)
4. Looks up where to send it based on the sender's phone number
5. Forwards the message to your service (e.g., your bot API)
6. If forwarding fails, retries automatically up to 5 times

Your services receive the message and respond directly via the Twilio API — this router doesn't pass responses back (it's a one-way relay).

---

## System Architecture

```
WhatsApp User
     │
     ▼
  Twilio
     │ POST /webhook (form-urlencoded)
     ▼
  Nginx (your-domain.com:443)
     │ proxy_pass to 127.0.0.1:3100
     ▼
  Node.js Server (src/index.js)
     │
     ├─ 1. Validate Twilio signature (HMAC-SHA1)
     ├─ 2. Store message in SQLite
     ├─ 3. Look up destination from config.json
     ├─ 4. Try immediate delivery (5s timeout)
     │     ├─ Success → mark delivered, done
     │     └─ Failure → queue for retry
     │
     └─ Worker (src/worker.js) runs every 5 seconds
           └─ Picks up pending deliveries, retries with backoff
```

### The Delivery Guarantee

**No message is ever lost.** Here's why:

1. The message is saved to SQLite *before* any delivery is attempted
2. If immediate delivery fails, a `pending` delivery record is created in the database
3. The worker picks it up and retries on a schedule
4. If the server crashes mid-delivery, on restart it resets any stuck `delivering` records back to `pending`
5. Every delivery attempt (success or failure) is logged in the `delivery_attempts` table

### Retry Schedule

| Attempt | Delay      |
|---------|------------|
| 1       | Immediate  |
| 2       | 30 seconds |
| 3       | 2 minutes  |
| 4       | 10 minutes |
| 5       | 1 hour     |

After 5 failed attempts, the delivery is marked `failed`. You can manually retry with `node cli.js retry <id>` or `POST /api/retry/:id`.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/samuel-langarica/twilio-wa-relay.git
cd twilio-wa-relay
npm install
mkdir -p data
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your values:
#   PORT=3100
#   HOST=127.0.0.1
#   TWILIO_AUTH_TOKEN=<from Twilio Console → Account Info>
#   WEBHOOK_SECRET=<generate: openssl rand -hex 32>
```

### 3. Configure routes

```bash
cat > config.json << 'EOF'
{
  "routes": {
    "whatsapp:+15551234567": "https://your-service.com/webhook"
  },
  "default": "https://fallback-service.com/webhook"
}
EOF
```

### 4. Start

```bash
# Development
npm run dev

# Production (with PM2)
pm2 start ecosystem.config.js
pm2 save
```

### 5. Set up Nginx (production)

Point your domain to the server. Update `nginx.conf` with your domain and SSL certs, then:

```bash
sudo cp nginx.conf /etc/nginx/sites-available/wa-relay
sudo ln -s /etc/nginx/sites-available/wa-relay /etc/nginx/sites-enabled/
sudo certbot --nginx -d your-domain.com
sudo nginx -t && sudo systemctl reload nginx
```

### 6. Configure Twilio

In your Twilio Console, set the WhatsApp sandbox/number webhook to:
```
POST https://your-domain.com/webhook
```

---

## Files — What Each One Does

### `src/index.js` — The HTTP Server

This is the entry point. PM2 runs this file.

- Creates a raw `node:http` server (no Express, no framework)
- `POST /webhook` — receives Twilio messages
- `/api/*` — management API (see `API.md`)
- Everything else gets 404
- **Twilio signature validation**: If `TWILIO_AUTH_TOKEN` is set in `.env`, it verifies every webhook request using HMAC-SHA1. If the token is not set, all requests are accepted.
- Stores the full raw payload as JSON in the `messages` table
- Looks up the destination URL from `config.json` based on the sender's phone number
- Tries to deliver immediately (5 second timeout)
- If delivery fails or times out, creates a `pending` delivery for the worker to retry
- Always responds to Twilio with `<Response></Response>` (empty TwiML)

On startup, it also:
- Loads `config.json` and starts watching it for changes
- Starts the delivery worker

### `src/worker.js` — The Retry Worker

Runs inside the same process as the server.

- Polls the database every 5 seconds for pending deliveries whose `next_retry_at` has passed
- Processes up to 10 deliveries per poll cycle
- For each delivery:
  1. Sets status to `delivering` (claims it)
  2. Reads the original raw payload from the `messages` table
  3. POSTs it to the destination URL as `application/x-www-form-urlencoded`
  4. Includes `X-WhatsApp-Router-Secret` header if `WEBHOOK_SECRET` is set
  5. On 2xx response → marks `delivered`
  6. On non-2xx or error → schedules retry with backoff, or marks `failed` after 5 attempts
  7. Logs every attempt to the `delivery_attempts` table

Uses Node's built-in `fetch()` with a 15-second timeout via `AbortController`.

### `src/config.js` — Route Configuration

Loads `config.json` and watches it for changes.

- On startup: reads and parses `config.json`
- `fs.watchFile()` checks the file every 1 second for modifications
- When the file changes, it reloads automatically — **no server restart needed**
- Also supports writes via the management API (`PUT /api/routes/:phone`)
- If `config.json` is missing or has invalid JSON, it logs a warning and keeps the last known good config

### `src/db.js` — Database Setup

Opens the SQLite database and creates tables if they don't exist.

- Database file: `data/webhook.db`
- WAL mode enabled (allows concurrent reads while writing)
- Creates 3 tables: `messages`, `deliveries`, `delivery_attempts`

### `cli.js` — Management CLI

Run from the project directory. Opens the database read-only (except for retry commands).

```bash
node cli.js status              # Message/delivery stats
node cli.js messages            # Recent messages (default 20)
node cli.js messages --limit=50 # Last 50 messages
node cli.js failed              # Failed deliveries
node cli.js retry 168           # Retry a specific failed delivery
node cli.js retry-all           # Retry ALL failed deliveries
node cli.js routes              # Show current routes from config.json
node cli.js help                # Show all commands
```

### `config.json` — Route Definitions

```json
{
  "routes": {
    "whatsapp:+15551234567": "https://service-a.com/webhook",
    "whatsapp:+15559876543": "https://service-b.com/webhook"
  },
  "default": "https://fallback.com/webhook"
}
```

- **`routes`**: Maps exact phone numbers (in Twilio's `whatsapp:+XXXXXXXXXXX` format) to destination URLs
- **`default`**: Fallback URL for any phone number not in `routes`. If null/missing and no route matches, the message is stored but not delivered.
- Edit and save — the server picks up changes within 1 second, no restart needed
- Can also be updated via `PUT /api/routes/:phone` (see `API.md`)
- This file is in `.gitignore` (environment-specific)

### `ecosystem.config.js` — PM2 Configuration

Tells PM2 how to run the app. Update the `cwd` path to match your installation directory.

### `nginx.conf` — Nginx Reverse Proxy (template)

Update with your domain and SSL certificate paths.

---

## Database Tables

### `messages` — Every inbound message (audit trail)

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `twilio_sid` | TEXT | Twilio's MessageSid |
| `from_number` | TEXT | Sender (e.g., `whatsapp:+15551234567`) |
| `to_number` | TEXT | Your Twilio number |
| `body` | TEXT | Message text |
| `num_media` | INTEGER | Number of media attachments |
| `media_urls` | TEXT | JSON array of media URLs |
| `raw_payload` | TEXT | Full Twilio POST body as JSON |
| `created_at` | TEXT | UTC timestamp |

### `deliveries` — The Job Queue

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Primary key |
| `message_id` | INTEGER | FK to `messages.id` |
| `destination_url` | TEXT | Where to deliver |
| `status` | TEXT | `pending`, `delivering`, `delivered`, or `failed` |
| `attempt_count` | INTEGER | How many times delivery was attempted |
| `max_attempts` | INTEGER | Always 5 |
| `next_retry_at` | TEXT | When the worker should next try |
| `last_error` | TEXT | Error from most recent failed attempt |
| `response_status` | INTEGER | HTTP status from destination |
| `response_body` | TEXT | Response body from destination |
| `response_headers` | TEXT | Response headers (JSON) |
| `created_at` | TEXT | When the delivery was created |
| `updated_at` | TEXT | Last status change |

**Status lifecycle:**
```
pending → delivering → delivered (success)
                    → pending (retry, attempt < 5)
                    → failed (gave up after 5 attempts)
```

On server startup, any `delivering` records (from a crash) are reset to `pending`.

### `delivery_attempts` — Attempt History

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Primary key |
| `delivery_id` | INTEGER | FK to `deliveries.id` |
| `attempt_number` | INTEGER | Which attempt (1-5) |
| `status_code` | INTEGER | HTTP status received (null if connection error) |
| `error` | TEXT | Error message (null if successful) |
| `response_body` | TEXT | Response body |
| `response_headers` | TEXT | Response headers (JSON) |
| `created_at` | TEXT | When the attempt happened |

---

## How Forwarding Works

When your service receives a delivery, it gets:

**Headers:**
```
Content-Type: application/x-www-form-urlencoded
X-WhatsApp-Router-Secret: <your WEBHOOK_SECRET>
```

**Body** (form-urlencoded, same format Twilio uses):
```
MessageSid=SM123&From=whatsapp%3A%2B15551234567&To=whatsapp%3A%2B14155238886&Body=Hello&NumMedia=0&...
```

Your service receives the exact same payload Twilio sent, in the same format. Parse it like any Twilio webhook. Your service must respond directly via the Twilio API (not via the HTTP response) because this router doesn't pass responses back.

---

## Common Operations

### Check if everything is working
```bash
node cli.js status
pm2 logs wa-relay --lines 20
# Or via API:
curl -H "Authorization: Bearer $SECRET" https://your-domain.com/api/status
```

### A message didn't arrive at my service
```bash
node cli.js messages --limit=10   # Was it received?
node cli.js failed                # Is the delivery stuck?
node cli.js retry <delivery_id>   # Retry it
```

### Change where messages go
```bash
# Option 1: Edit config file directly
nano config.json    # Server reloads automatically

# Option 2: Via API (from any computer)
curl -X PUT \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://new-destination.com/webhook"}' \
  "https://your-domain.com/api/routes/whatsapp%3A%2B15551234567"
```

### My service was down, retry all failed deliveries
```bash
node cli.js retry-all
# Or via API:
curl -X POST -H "Authorization: Bearer $SECRET" https://your-domain.com/api/retry-all
```

### Restart the server
```bash
pm2 reload wa-relay    # Graceful reload (no downtime)
```

### View logs
```bash
pm2 logs wa-relay              # Live tail (Ctrl+C to stop)
pm2 logs wa-relay --lines 100  # Last 100 lines
```

### Query the database directly
```bash
sqlite3 data/webhook.db "SELECT COUNT(*) FROM messages;"
sqlite3 data/webhook.db "SELECT * FROM deliveries WHERE status = 'failed';"
```

---

## What Happens When Things Go Wrong

| Scenario | What happens |
|----------|-------------|
| **Server crashes** | PM2 auto-restarts. Stuck `delivering` entries reset to `pending`. |
| **Destination service is down** | Retries 5 times with backoff. Marked `failed` after 5 attempts. Use `retry-all` after service is back. |
| **Database disk is full** | Returns 500 to Twilio. Twilio retries on its end. Fix disk, messages flow again. |
| **Fake requests** | Rejected with 403 if `TWILIO_AUTH_TOKEN` is set (HMAC-SHA1 validation). |
| **Invalid config.json** | Logs parse error, keeps using last valid config. Fix JSON, auto-reloads. |
| **config.json deleted** | Keeps using last known config in memory. Recreate file, auto-picks up. |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `3100`) |
| `HOST` | No | Bind address (default: `127.0.0.1`) |
| `TWILIO_AUTH_TOKEN` | Recommended | Twilio auth token for signature validation. Found in Twilio Console → Account Info. Without this, anyone can POST to `/webhook`. |
| `WEBHOOK_SECRET` | Recommended | Dual purpose: (1) Sent as `X-WhatsApp-Router-Secret` header to your services. (2) Bearer token for the management API. Generate with `openssl rand -hex 32`. |
