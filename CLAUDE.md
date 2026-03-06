# twilio-wa-relay

Lightweight async WhatsApp webhook router. Receives messages from Twilio, stores them, and delivers to configured services with automatic retries. Zero-framework: uses node:http, fetch, and better-sqlite3.

## Tech Stack

Node.js (built-in http + fetch), SQLite (better-sqlite3), PM2, Nginx

## File Structure

```
src/
  index.js      — HTTP server (node:http), POST /webhook + /api/* management endpoints
  db.js         — SQLite schema: messages, deliveries, delivery_attempts
  worker.js     — Delivery retry worker with backoff (setInterval-based)
  config.js     — JSON config loader with fs.watchFile hot-reload
cli.js          — CLI tool for monitoring/management
config.json     — Route configuration (phone → URL mapping)
data/webhook.db — SQLite database (WAL mode)
```

## Running

- Development: `npm run dev`
- Production: `pm2 reload ecosystem.config.js`

## CLI

```
node cli.js status              # Message/delivery stats
node cli.js messages [--limit=N] # Recent messages
node cli.js failed              # Failed deliveries
node cli.js retry <id>          # Retry a failed delivery
node cli.js retry-all           # Retry all failed
node cli.js routes              # Show current routes from config
```

## Config

Routes are defined in `config.json` (hot-reloaded on change):
```json
{
  "routes": {
    "whatsapp:+15551234567": "https://service.example.com/webhook"
  },
  "default": "https://fallback.example.com/webhook"
}
```

## Database

SQLite at `data/webhook.db`, WAL mode enabled. Tables:
- `messages` — Raw inbound messages from Twilio
- `deliveries` — Job queue (pending/delivering/delivered/failed)
- `delivery_attempts` — Retry history

## Management API

All `/api/*` endpoints authenticated via `Authorization: Bearer <WEBHOOK_SECRET>`. Full reference in `API.md`.

- `GET /api/health` — health check (no auth)
- `GET /api/status` — message/delivery counts
- `GET/PUT/DELETE /api/routes` — route CRUD (writes to config.json)
- `PUT /api/default` — set default destination
- `GET /api/messages` — list messages with delivery status
- `GET /api/deliveries` — list/filter deliveries
- `POST /api/retry/:id` — retry failed delivery
- `POST /api/retry-all` — retry all failed

## Architecture

- **Async delivery**: Webhook accepts immediately (200 OK), worker delivers independently
- **Immediate attempt**: Webhook tries delivery inline first, queues for retry on failure
- **Deliveries table as job queue**: `pending` → `delivering` → `delivered`/`failed`
- **setInterval worker**: Polls every 5s, no external job queue needed (single VPS)
- **Retry backoff**: immediate, 30s, 2m, 10m, 1h (5 attempts max)
- **Startup recovery**: Stale `delivering` entries reset to `pending` on boot
- **Config hot-reload**: fs.watchFile detects config.json changes, no restart needed
- **Services must reply via Twilio API**: No response passthrough (async model)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3100) |
| `HOST` | Bind address (default: 127.0.0.1) |
| `TWILIO_AUTH_TOKEN` | For webhook signature validation (optional) |
| `WEBHOOK_SECRET` | Sent as X-WhatsApp-Router-Secret header + API auth token |

## Deployment

PM2 for process management. Nginx reverse proxy recommended. See `OPERATIONS.md` for full guide.

## Dependencies

- `better-sqlite3` — SQLite driver
- `dotenv` — Environment variables
