# twilio-wa-relay

Lightweight WhatsApp webhook router for Twilio. Receives inbound messages, stores them in SQLite, and forwards to your services with automatic retries.

- **Zero framework** — `node:http` + `fetch()` + `better-sqlite3` (2 dependencies)
- **Reliable delivery** — messages stored before delivery, 5-attempt retry with exponential backoff
- **Hot-reload routing** — edit `config.json` or call the API, no restart needed
- **Management API** — monitor messages, manage routes, retry failures from any computer
- **CLI tool** — check status, view messages, retry deliveries over SSH

## How it works

```
WhatsApp → Twilio → POST /webhook → Store in SQLite → Forward to your service
                                                    → Retry on failure (5 attempts)
```

Messages are stored immediately, then delivered asynchronously. If delivery fails, a background worker retries with backoff: immediate → 30s → 2m → 10m → 1h. Your services respond via the Twilio API directly (no response passthrough).

## Quick start

```bash
git clone https://github.com/samuel-langarica/twilio-wa-relay.git
cd twilio-wa-relay
npm install
mkdir -p data

# Configure
cp .env.example .env
# Edit .env: set TWILIO_AUTH_TOKEN and WEBHOOK_SECRET

# Set up routes
cat > config.json << 'EOF'
{
  "routes": {
    "whatsapp:+15551234567": "https://your-service.com/webhook"
  },
  "default": "https://fallback.com/webhook"
}
EOF

# Run
npm run dev
```

Set your Twilio WhatsApp webhook to `POST https://your-domain.com/webhook`.

## Configuration

### Environment variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `3100`) |
| `HOST` | No | Bind address (default: `127.0.0.1`) |
| `TWILIO_AUTH_TOKEN` | Recommended | Validates webhook signatures. From Twilio Console → Account Info. |
| `WEBHOOK_SECRET` | Recommended | Sent as `X-WhatsApp-Router-Secret` header to services. Also used as Bearer token for the management API. |

### Routes (`config.json`)

```json
{
  "routes": {
    "whatsapp:+15551234567": "https://service-a.com/webhook",
    "whatsapp:+15559876543": "https://service-b.com/webhook"
  },
  "default": "https://fallback.com/webhook"
}
```

- Phone numbers use Twilio's format: `whatsapp:+<country><number>`
- `default` catches any number without a specific route
- File is watched — save and changes apply within 1 second
- Routes can also be updated via the management API

## CLI

```bash
node cli.js status                # Message/delivery counts
node cli.js messages [--limit=N]  # Recent messages
node cli.js failed                # Failed deliveries
node cli.js retry <id>            # Retry a failed delivery
node cli.js retry-all             # Retry all failed
node cli.js routes                # Show current routes
```

## Management API

All endpoints require `Authorization: Bearer <WEBHOOK_SECRET>` except health.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check (no auth) |
| `GET` | `/api/status` | Message/delivery counts |
| `GET` | `/api/routes` | List all routes |
| `PUT` | `/api/routes/:phone` | Set a route |
| `DELETE` | `/api/routes/:phone` | Delete a route |
| `PUT` | `/api/default` | Set default destination |
| `GET` | `/api/messages?limit=20` | List recent messages |
| `GET` | `/api/messages/:id` | Message detail with delivery attempts |
| `GET` | `/api/deliveries?status=failed` | List deliveries (filterable) |
| `GET` | `/api/deliveries/:id` | Delivery detail with attempt history |
| `POST` | `/api/retry/:id` | Retry a failed delivery |
| `POST` | `/api/retry-all` | Retry all failed deliveries |

### Example: update a route from your laptop

```bash
curl -X PUT \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://new-tunnel.ngrok-free.app/webhook"}' \
  "https://your-domain.com/api/routes/whatsapp%3A%2B15551234567"
```

See [`API.md`](API.md) for the full reference with request/response examples.

## Production deployment

```bash
# PM2
pm2 start ecosystem.config.js
pm2 save

# Nginx (update nginx.conf with your domain first)
sudo cp nginx.conf /etc/nginx/sites-available/wa-relay
sudo ln -s /etc/nginx/sites-available/wa-relay /etc/nginx/sites-enabled/
sudo certbot --nginx -d your-domain.com
sudo nginx -t && sudo systemctl reload nginx
```

See [`OPERATIONS.md`](OPERATIONS.md) for the full operations guide.

## What your service receives

**Headers:**
```
Content-Type: application/x-www-form-urlencoded
X-WhatsApp-Router-Secret: <your WEBHOOK_SECRET>
```

**Body** — the exact Twilio payload, form-urlencoded:
```
MessageSid=SM123&From=whatsapp%3A%2B15551234567&Body=Hello&NumMedia=0&...
```

Parse it like any standard Twilio webhook. Your service responds via the Twilio API directly.

## License

MIT
