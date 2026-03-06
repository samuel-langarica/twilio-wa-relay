# twilio-wa-relay — API Reference

Base URL: `https://your-domain.com` (wherever you deploy this)

## Authentication

All endpoints except `/api/health` require a Bearer token:

```
Authorization: Bearer <WEBHOOK_SECRET>
```

The token is the `WEBHOOK_SECRET` value from your `.env` file. Requests without a valid token receive `401 Unauthorized`.

---

## Endpoints

### Health Check

```
GET /api/health
```

No authentication required. Use for uptime monitoring.

**Response `200`**
```json
{
  "ok": true,
  "uptime": 3600
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always `true` if server is running |
| `uptime` | number | Seconds since server started |

---

### Status Overview

```
GET /api/status
```

**Response `200`**
```json
{
  "messages": 214,
  "deliveries": {
    "delivered": 206,
    "failed": 8,
    "pending": 0,
    "delivering": 0
  },
  "last_message_at": "2026-03-06 00:25:06"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `messages` | number | Total messages received |
| `deliveries` | object | Count of deliveries by status |
| `last_message_at` | string\|null | UTC timestamp of most recent message |

---

### Routes

#### List all routes

```
GET /api/routes
```

**Response `200`**
```json
{
  "routes": {
    "whatsapp:+15551234567": "https://service-a.example.com/webhook",
    "whatsapp:+15559876543": "https://service-b.example.com/webhook"
  },
  "default": "https://fallback.example.com/webhook"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `routes` | object | Phone number → destination URL mapping |
| `default` | string\|null | Fallback URL for unmatched numbers |

#### Set a route

```
PUT /api/routes/:phone
Content-Type: application/json
```

The `:phone` parameter must be URL-encoded. Example: `whatsapp:+15551234567` → `whatsapp%3A%2B15551234567`

**Request body**
```json
{
  "url": "https://your-service.example.com/webhook"
}
```

**Response `200`**
```json
{
  "ok": true,
  "phone": "whatsapp:+15551234567",
  "url": "https://your-service.example.com/webhook"
}
```

Creates the route if it doesn't exist, updates it if it does. Changes take effect immediately (no restart needed).

**Errors**
- `400` — Missing or invalid `url` field, or invalid JSON body

#### Delete a route

```
DELETE /api/routes/:phone
```

**Response `200`**
```json
{
  "ok": true,
  "phone": "whatsapp:+15551234567"
}
```

**Errors**
- `404` — No route exists for that phone number

#### Set default destination

```
PUT /api/default
Content-Type: application/json
```

**Request body**
```json
{
  "url": "https://fallback.example.com/webhook"
}
```

**Response `200`**
```json
{
  "ok": true,
  "default": "https://fallback.example.com/webhook"
}
```

Messages from phone numbers without a specific route are sent here.

---

### Messages

#### List recent messages

```
GET /api/messages?limit=20
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 20 | Number of messages to return (max 200) |

**Response `200`**
```json
{
  "messages": [
    {
      "id": 214,
      "twilio_sid": "SMfc9ee2a0a52b730521de2c16d4b2a803",
      "from": "whatsapp:+15551234567",
      "to": "whatsapp:+14155238886",
      "body": "Hello!",
      "num_media": 0,
      "media_urls": [],
      "created_at": "2026-03-06 00:25:06",
      "delivery": {
        "id": 214,
        "status": "delivered",
        "destination_url": "https://your-service.example.com/webhook",
        "attempt_count": 1,
        "response_status": 200
      }
    }
  ]
}
```

Messages are sorted newest first. `delivery` is `null` if no route matched when the message arrived.

#### Get a single message

```
GET /api/messages/:id
```

**Response `200`**
```json
{
  "id": 211,
  "twilio_sid": "SMeace30559e62cca48a07caca1a9024d8",
  "from": "whatsapp:+15551234567",
  "to": "whatsapp:+14155238886",
  "body": "Hello!",
  "num_media": 0,
  "media_urls": [],
  "raw_payload": {
    "SmsMessageSid": "SMeace30559e62cca48a07caca1a9024d8",
    "NumMedia": "0",
    "ProfileName": "John Doe",
    "Body": "Hello!",
    "From": "whatsapp:+15551234567",
    "To": "whatsapp:+14155238886"
  },
  "created_at": "2026-03-06 00:14:13",
  "delivery": {
    "id": 211,
    "status": "delivered",
    "destination_url": "https://your-service.example.com/webhook",
    "attempt_count": 1,
    "max_attempts": 5,
    "last_error": null,
    "response_status": 200,
    "created_at": "2026-03-06 00:14:14",
    "updated_at": "2026-03-06 00:14:14",
    "attempts": [
      {
        "attempt_number": 1,
        "status_code": 200,
        "error": null,
        "response_body": "{\"success\":true}",
        "created_at": "2026-03-06 00:14:14"
      }
    ]
  }
}
```

The single-message endpoint includes the full `raw_payload` (everything Twilio sent) and the complete `attempts` history.

**Errors**
- `404` — Message not found

---

### Deliveries

#### List deliveries

```
GET /api/deliveries?status=failed&limit=50
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string | (all) | Filter: `pending`, `delivering`, `delivered`, `failed` |
| `limit` | number | 50 | Number of deliveries to return (max 200) |

**Response `200`**
```json
{
  "deliveries": [
    {
      "id": 168,
      "message_id": 168,
      "destination_url": "https://old-tunnel.ngrok-free.app/webhook",
      "status": "failed",
      "attempt_count": 5,
      "max_attempts": 5,
      "last_error": "HTTP 404",
      "response_status": 404,
      "created_at": "2026-03-04 01:15:17",
      "updated_at": "2026-03-04 02:28:05",
      "message": {
        "from": "whatsapp:+15551234567",
        "body": "Hello"
      }
    }
  ]
}
```

Sorted by `updated_at` descending (most recent activity first).

#### Get a single delivery

```
GET /api/deliveries/:id
```

**Response `200`**
```json
{
  "id": 168,
  "message_id": 168,
  "destination_url": "https://old-tunnel.ngrok-free.app/webhook",
  "status": "failed",
  "attempt_count": 5,
  "max_attempts": 5,
  "last_error": "HTTP 404",
  "response_status": 404,
  "response_body": "Not Found",
  "created_at": "2026-03-04 01:15:17",
  "updated_at": "2026-03-04 02:28:05",
  "message": {
    "from": "whatsapp:+15551234567",
    "body": "Hello"
  },
  "attempts": [
    {
      "attempt_number": 1,
      "status_code": 404,
      "error": "HTTP 404",
      "response_body": "Not Found",
      "created_at": "2026-03-04 01:15:17"
    }
  ]
}
```

**Errors**
- `404` — Delivery not found

---

### Retry

#### Retry a single delivery

```
POST /api/retry/:id
```

Resets a `failed` delivery back to `pending` with `attempt_count = 0`. The worker picks it up within 5 seconds.

**Response `200`**
```json
{
  "ok": true,
  "delivery_id": 168,
  "status": "pending"
}
```

**Errors**
- `404` — Delivery not found
- `400` — Delivery is not in `failed` status

#### Retry all failed

```
POST /api/retry-all
```

Resets every `failed` delivery back to `pending`.

**Response `200`**
```json
{
  "ok": true,
  "retried": 8
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Description of what went wrong"
}
```

| Status | Meaning |
|--------|---------|
| `400` | Bad request (missing fields, invalid JSON, wrong status) |
| `401` | Missing or invalid `Authorization: Bearer` token |
| `404` | Resource not found |
| `500` | Server error |

---

## Models Reference

### Message

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique message ID |
| `twilio_sid` | string | Twilio's MessageSid |
| `from` | string | Sender in Twilio format: `whatsapp:+XXXXXXXXXXX` |
| `to` | string | Your Twilio number in same format |
| `body` | string | Message text content |
| `num_media` | number | Number of media attachments |
| `media_urls` | string[] | Array of media URLs from Twilio |
| `raw_payload` | object | Full Twilio POST body (only in single-message endpoint) |
| `created_at` | string | UTC timestamp `YYYY-MM-DD HH:MM:SS` |
| `delivery` | Delivery\|null | Associated delivery, null if no route matched |

### Delivery

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique delivery ID |
| `message_id` | number | FK to the message |
| `destination_url` | string | Where the message was/is being sent |
| `status` | string | `pending` \| `delivering` \| `delivered` \| `failed` |
| `attempt_count` | number | How many delivery attempts so far |
| `max_attempts` | number | Maximum attempts (always 5) |
| `last_error` | string\|null | Error from most recent failed attempt |
| `response_status` | number\|null | HTTP status from destination |
| `response_body` | string\|null | Response body (only in single-delivery endpoint) |
| `created_at` | string | UTC timestamp |
| `updated_at` | string | Last status change timestamp |
| `message` | object | `{ from, body }` summary (in list views) |
| `attempts` | Attempt[] | Full attempt history (in detail views) |

### Attempt

| Field | Type | Description |
|-------|------|-------------|
| `attempt_number` | number | Which attempt (1-5) |
| `status_code` | number\|null | HTTP status received, null if connection error |
| `error` | string\|null | Error message, null if successful |
| `response_body` | string\|null | Response body from destination |
| `created_at` | string | When the attempt was made |

### Delivery Status Lifecycle

```
pending → delivering → delivered    (success)
                    → pending       (retry, attempt < 5)
                    → failed        (gave up after 5 attempts)
```

---

## Integration Examples

### Update ngrok tunnel (curl)

```bash
export ROUTER_SECRET="your-webhook-secret"
export ROUTER_URL="https://your-domain.com"

curl -s -X PUT \
  -H "Authorization: Bearer $ROUTER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://NEW-TUNNEL.ngrok-free.app/webhook"}' \
  "$ROUTER_URL/api/routes/whatsapp%3A%2B15551234567"
```

### JavaScript / Node.js

```javascript
const ROUTER_URL = process.env.ROUTER_URL;
const ROUTER_SECRET = process.env.ROUTER_SECRET;

async function updateRoute(phone, destinationUrl) {
  const encodedPhone = encodeURIComponent(phone);
  const res = await fetch(`${ROUTER_URL}/api/routes/${encodedPhone}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${ROUTER_SECRET}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: destinationUrl })
  });
  return res.json();
}

async function getStatus() {
  const res = await fetch(`${ROUTER_URL}/api/status`, {
    headers: { 'Authorization': `Bearer ${ROUTER_SECRET}` }
  });
  return res.json();
}

async function getFailedDeliveries() {
  const res = await fetch(`${ROUTER_URL}/api/deliveries?status=failed`, {
    headers: { 'Authorization': `Bearer ${ROUTER_SECRET}` }
  });
  const data = await res.json();
  return data.deliveries;
}

async function retryAll() {
  const res = await fetch(`${ROUTER_URL}/api/retry-all`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ROUTER_SECRET}` }
  });
  return res.json();
}
```

### Python

```python
import requests
from urllib.parse import quote

ROUTER_URL = "https://your-domain.com"
ROUTER_SECRET = "your-webhook-secret"
HEADERS = {"Authorization": f"Bearer {ROUTER_SECRET}"}

def get_status():
    return requests.get(f"{ROUTER_URL}/api/status", headers=HEADERS).json()

def get_messages(limit=20):
    return requests.get(f"{ROUTER_URL}/api/messages", headers=HEADERS, params={"limit": limit}).json()

def update_route(phone, url):
    encoded = quote(phone, safe="")
    return requests.put(
        f"{ROUTER_URL}/api/routes/{encoded}",
        headers={**HEADERS, "Content-Type": "application/json"},
        json={"url": url}
    ).json()

def get_failed():
    return requests.get(f"{ROUTER_URL}/api/deliveries", headers=HEADERS, params={"status": "failed"}).json()

def retry_all():
    return requests.post(f"{ROUTER_URL}/api/retry-all", headers=HEADERS).json()
```

### Shell script for ngrok automation

Save as `update-route.sh`:

```bash
#!/bin/bash
# Usage: ./update-route.sh <ngrok-url>

ROUTER_URL="${ROUTER_URL:?Set ROUTER_URL env var}"
ROUTER_SECRET="${ROUTER_SECRET:?Set ROUTER_SECRET env var}"
PHONE="${PHONE:?Set PHONE env var (e.g. whatsapp%3A%2B15551234567)}"

if [ -z "$1" ]; then
  echo "Usage: $0 <destination-url>"
  exit 1
fi

curl -s -X PUT \
  -H "Authorization: Bearer $ROUTER_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$1\"}" \
  "$ROUTER_URL/api/routes/$PHONE"

echo ""
```

---

## Testing from a Client Computer

### Quick connectivity test

```bash
curl https://your-domain.com/api/health
```

### Full test sequence

```bash
export S="your-webhook-secret"
export U="https://your-domain.com"

# 1. Health check (no auth)
curl -s "$U/api/health"

# 2. Status
curl -s -H "Authorization: Bearer $S" "$U/api/status"

# 3. View routes
curl -s -H "Authorization: Bearer $S" "$U/api/routes"

# 4. Add a route
curl -s -X PUT \
  -H "Authorization: Bearer $S" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://test.example.com/webhook"}' \
  "$U/api/routes/whatsapp%3A%2B15551234567"

# 5. Verify
curl -s -H "Authorization: Bearer $S" "$U/api/routes"

# 6. Delete test route
curl -s -X DELETE -H "Authorization: Bearer $S" "$U/api/routes/whatsapp%3A%2B15551234567"

# 7. Recent messages
curl -s -H "Authorization: Bearer $S" "$U/api/messages?limit=5"

# 8. Failed deliveries
curl -s -H "Authorization: Bearer $S" "$U/api/deliveries?status=failed"

# 9. Retry all failed
curl -s -X POST -H "Authorization: Bearer $S" "$U/api/retry-all"
```
