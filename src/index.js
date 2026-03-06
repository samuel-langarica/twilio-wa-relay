require('dotenv').config();

const http = require('node:http');
const crypto = require('node:crypto');
const querystring = require('node:querystring');
const db = require('./db');
const config = require('./config');
const worker = require('./worker');

const startTime = Date.now();
const INLINE_TIMEOUT = 5000;
const FIRST_RETRY_DELAY = 30;

// --- Prepared statements: webhook ---

const insertMessage = db.prepare(`
  INSERT INTO messages (twilio_sid, from_number, to_number, body, num_media, media_urls, raw_payload)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertDeliveryDelivered = db.prepare(`
  INSERT INTO deliveries (message_id, destination_url, status, attempt_count, response_status, response_body, response_headers)
  VALUES (?, ?, 'delivered', 1, ?, ?, ?)
`);

const insertDeliveryPending = db.prepare(`
  INSERT INTO deliveries (message_id, destination_url, status, attempt_count, next_retry_at, last_error, response_status)
  VALUES (?, ?, 'pending', 1, datetime('now', '+' || ? || ' seconds'), ?, ?)
`);

const logAttempt = db.prepare(`
  INSERT INTO delivery_attempts (delivery_id, attempt_number, status_code, error, response_body, response_headers)
  VALUES (?, 1, ?, ?, ?, ?)
`);

// --- Prepared statements: API ---

const qMessageCount = db.prepare('SELECT COUNT(*) as count FROM messages');
const qDeliveryCounts = db.prepare('SELECT status, COUNT(*) as count FROM deliveries GROUP BY status');
const qLastMessage = db.prepare('SELECT created_at FROM messages ORDER BY id DESC LIMIT 1');

const qMessages = db.prepare(`
  SELECT m.id, m.twilio_sid, m.from_number, m.to_number, m.body, m.num_media, m.media_urls, m.created_at,
         d.id as d_id, d.status as d_status, d.destination_url as d_url, d.attempt_count as d_attempts, d.response_status as d_response_status
  FROM messages m
  LEFT JOIN deliveries d ON d.message_id = m.id
  ORDER BY m.id DESC
  LIMIT ?
`);

const qMessageById = db.prepare(`
  SELECT m.*, d.id as d_id, d.destination_url as d_url, d.status as d_status,
         d.attempt_count as d_attempts, d.max_attempts as d_max_attempts,
         d.last_error as d_last_error, d.response_status as d_response_status,
         d.created_at as d_created_at, d.updated_at as d_updated_at
  FROM messages m
  LEFT JOIN deliveries d ON d.message_id = m.id
  WHERE m.id = ?
`);

const qAttemptsByDelivery = db.prepare(`
  SELECT attempt_number, status_code, error, response_body, created_at
  FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number
`);

const qDeliveries = db.prepare(`
  SELECT d.id, d.message_id, d.destination_url, d.status, d.attempt_count, d.max_attempts,
         d.last_error, d.response_status, d.created_at, d.updated_at,
         m.from_number, m.body
  FROM deliveries d
  JOIN messages m ON m.id = d.message_id
  ORDER BY d.updated_at DESC
  LIMIT ?
`);

const qDeliveriesByStatus = db.prepare(`
  SELECT d.id, d.message_id, d.destination_url, d.status, d.attempt_count, d.max_attempts,
         d.last_error, d.response_status, d.created_at, d.updated_at,
         m.from_number, m.body
  FROM deliveries d
  JOIN messages m ON m.id = d.message_id
  WHERE d.status = ?
  ORDER BY d.updated_at DESC
  LIMIT ?
`);

const qDeliveryById = db.prepare(`
  SELECT d.*, m.from_number, m.body
  FROM deliveries d
  JOIN messages m ON m.id = d.message_id
  WHERE d.id = ?
`);

const qRetryOne = db.prepare(`
  UPDATE deliveries
  SET status = 'pending', attempt_count = 0, next_retry_at = datetime('now'), updated_at = datetime('now')
  WHERE id = ? AND status = 'failed'
`);

const qRetryAll = db.prepare(`
  UPDATE deliveries
  SET status = 'pending', attempt_count = 0, next_retry_at = datetime('now'), updated_at = datetime('now')
  WHERE status = 'failed'
`);

// --- Helpers ---

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function parseBodyRaw(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseUrl(url) {
  const [path, qs] = (url || '').split('?');
  const params = {};
  if (qs) {
    for (const part of qs.split('&')) {
      const [k, v] = part.split('=');
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  return { path, params };
}

function validateTwilioSignature(authToken, signature, url, params) {
  const keys = Object.keys(params).sort();
  let data = url;
  for (const key of keys) {
    data += key + params[key];
  }
  const expected = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function checkAuth(req) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true;
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token === secret;
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}

// --- Webhook handler ---

async function handleWebhook(req, res) {
  const raw = await parseBodyRaw(req);
  const payload = querystring.parse(raw);

  if (process.env.TWILIO_AUTH_TOKEN) {
    const signature = req.headers['x-twilio-signature'] || '';
    const url = `https://${req.headers.host}${req.url}`;
    try {
      if (!validateTwilioSignature(process.env.TWILIO_AUTH_TOKEN, signature, url, payload)) {
        log('Invalid Twilio signature, rejecting request');
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Invalid signature');
        return;
      }
    } catch {
      log('Invalid Twilio signature (malformed), rejecting request');
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Invalid signature');
      return;
    }
  }

  const from = payload.From || '';
  const to = payload.To || '';
  const body = payload.Body || '';
  const sid = payload.MessageSid || payload.SmsSid || '';
  const numMedia = parseInt(payload.NumMedia, 10) || 0;

  const mediaUrls = [];
  for (let i = 0; i < numMedia; i++) {
    const url = payload[`MediaUrl${i}`];
    if (url) mediaUrls.push(url);
  }

  let messageId;
  try {
    const result = insertMessage.run(
      sid, from, to, body, numMedia,
      JSON.stringify(mediaUrls),
      JSON.stringify(payload)
    );
    messageId = result.lastInsertRowid;
  } catch (err) {
    log(`DB insert error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'text/xml' });
    res.end('<Response></Response>');
    return;
  }

  const destination = config.getDestination(from);

  if (!destination) {
    log(`No route configured for ${from}`);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end('<Response></Response>');
    return;
  }

  log(`Message #${messageId} from ${from}: "${body.slice(0, 50)}${body.length > 50 ? '...' : ''}" → ${destination}`);

  try {
    const result = await worker.forward(destination, payload);
    const responseHeaders = JSON.stringify(result.headers);

    if (result.status >= 200 && result.status < 300) {
      const del = insertDeliveryDelivered.run(messageId, destination, result.status, result.body, responseHeaders);
      logAttempt.run(del.lastInsertRowid, result.status, null, result.body, responseHeaders);
      log(`Delivered message #${messageId} to ${destination} (${result.status})`);
    } else {
      const error = `HTTP ${result.status}`;
      const del = insertDeliveryPending.run(messageId, destination, FIRST_RETRY_DELAY, error, result.status);
      logAttempt.run(del.lastInsertRowid, result.status, error, result.body, responseHeaders);
      log(`Delivery failed for message #${messageId} (${error}), queued for retry`);
    }
  } catch (err) {
    const msg = err.name === 'AbortError' ? `Timeout (${INLINE_TIMEOUT}ms)` : err.message;
    const del = insertDeliveryPending.run(messageId, destination, FIRST_RETRY_DELAY, msg, null);
    logAttempt.run(del.lastInsertRowid, null, msg, null, null);
    log(`Delivery error for message #${messageId} (${msg}), queued for retry`);
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end('<Response></Response>');
}

// --- API handlers ---

async function handleApi(req, res) {
  const { path, params } = parseUrl(req.url);
  const method = req.method;

  // Health — no auth
  if (method === 'GET' && path === '/api/health') {
    return json(res, 200, { ok: true, uptime: Math.floor((Date.now() - startTime) / 1000) });
  }

  // Auth check for all other /api/* endpoints
  if (!checkAuth(req)) {
    return json(res, 401, { error: 'Unauthorized. Set Authorization: Bearer <WEBHOOK_SECRET>' });
  }

  // --- Status ---
  if (method === 'GET' && path === '/api/status') {
    const msgs = qMessageCount.get();
    const rows = qDeliveryCounts.all();
    const deliveries = {};
    for (const r of rows) deliveries[r.status] = r.count;
    const last = qLastMessage.get();
    return json(res, 200, {
      messages: msgs.count,
      deliveries,
      last_message_at: last ? last.created_at : null
    });
  }

  // --- Routes ---
  if (method === 'GET' && path === '/api/routes') {
    return json(res, 200, config.getConfig());
  }

  if (method === 'PUT' && path.startsWith('/api/routes/')) {
    const phone = decodeURIComponent(path.slice('/api/routes/'.length));
    if (!phone) return json(res, 400, { error: 'Phone number required' });
    const raw = await parseBodyRaw(req);
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Invalid JSON body' }); }
    if (!body.url) return json(res, 400, { error: 'Missing "url" field' });
    config.setRoute(phone, body.url);
    log(`API: route set ${phone} → ${body.url}`);
    return json(res, 200, { ok: true, phone, url: body.url });
  }

  if (method === 'DELETE' && path.startsWith('/api/routes/')) {
    const phone = decodeURIComponent(path.slice('/api/routes/'.length));
    if (!phone) return json(res, 400, { error: 'Phone number required' });
    const existed = config.deleteRoute(phone);
    if (!existed) return json(res, 404, { error: `No route for ${phone}` });
    log(`API: route deleted ${phone}`);
    return json(res, 200, { ok: true, phone });
  }

  // --- Default ---
  if (method === 'PUT' && path === '/api/default') {
    const raw = await parseBodyRaw(req);
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Invalid JSON body' }); }
    if (!body.url) return json(res, 400, { error: 'Missing "url" field' });
    config.setDefault(body.url);
    log(`API: default set → ${body.url}`);
    return json(res, 200, { ok: true, default: body.url });
  }

  // --- Messages ---
  if (method === 'GET' && path === '/api/messages') {
    const limit = parseInt(params.limit, 10) || 20;
    const rows = qMessages.all(Math.min(limit, 200));
    const messages = rows.map(r => ({
      id: r.id,
      twilio_sid: r.twilio_sid,
      from: r.from_number,
      to: r.to_number,
      body: r.body,
      num_media: r.num_media,
      media_urls: safeParse(r.media_urls),
      created_at: r.created_at,
      delivery: r.d_id ? {
        id: r.d_id,
        status: r.d_status,
        destination_url: r.d_url,
        attempt_count: r.d_attempts,
        response_status: r.d_response_status
      } : null
    }));
    return json(res, 200, { messages });
  }

  if (method === 'GET' && path.match(/^\/api\/messages\/\d+$/)) {
    const id = parseInt(path.split('/').pop(), 10);
    const r = qMessageById.get(id);
    if (!r) return json(res, 404, { error: 'Message not found' });

    const msg = {
      id: r.id,
      twilio_sid: r.twilio_sid,
      from: r.from_number,
      to: r.to_number,
      body: r.body,
      num_media: r.num_media,
      media_urls: safeParse(r.media_urls),
      raw_payload: safeParse(r.raw_payload),
      created_at: r.created_at,
      delivery: null
    };

    if (r.d_id) {
      const attempts = qAttemptsByDelivery.all(r.d_id);
      msg.delivery = {
        id: r.d_id,
        status: r.d_status,
        destination_url: r.d_url,
        attempt_count: r.d_attempts,
        max_attempts: r.d_max_attempts,
        last_error: r.d_last_error,
        response_status: r.d_response_status,
        created_at: r.d_created_at,
        updated_at: r.d_updated_at,
        attempts: attempts.map(a => ({
          attempt_number: a.attempt_number,
          status_code: a.status_code,
          error: a.error,
          response_body: a.response_body,
          created_at: a.created_at
        }))
      };
    }

    return json(res, 200, msg);
  }

  // --- Deliveries ---
  if (method === 'GET' && path === '/api/deliveries') {
    const limit = parseInt(params.limit, 10) || 50;
    const status = params.status || null;
    const rows = status
      ? qDeliveriesByStatus.all(status, Math.min(limit, 200))
      : qDeliveries.all(Math.min(limit, 200));

    const deliveries = rows.map(r => ({
      id: r.id,
      message_id: r.message_id,
      destination_url: r.destination_url,
      status: r.status,
      attempt_count: r.attempt_count,
      max_attempts: r.max_attempts,
      last_error: r.last_error,
      response_status: r.response_status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      message: { from: r.from_number, body: r.body }
    }));
    return json(res, 200, { deliveries });
  }

  if (method === 'GET' && path.match(/^\/api\/deliveries\/\d+$/)) {
    const id = parseInt(path.split('/').pop(), 10);
    const r = qDeliveryById.get(id);
    if (!r) return json(res, 404, { error: 'Delivery not found' });
    const attempts = qAttemptsByDelivery.all(id);
    return json(res, 200, {
      id: r.id,
      message_id: r.message_id,
      destination_url: r.destination_url,
      status: r.status,
      attempt_count: r.attempt_count,
      max_attempts: r.max_attempts,
      last_error: r.last_error,
      response_status: r.response_status,
      response_body: r.response_body,
      created_at: r.created_at,
      updated_at: r.updated_at,
      message: { from: r.from_number, body: r.body },
      attempts: attempts.map(a => ({
        attempt_number: a.attempt_number,
        status_code: a.status_code,
        error: a.error,
        response_body: a.response_body,
        created_at: a.created_at
      }))
    });
  }

  // --- Retry ---
  if (method === 'POST' && path.match(/^\/api\/retry\/\d+$/)) {
    const id = parseInt(path.split('/').pop(), 10);
    const result = qRetryOne.run(id);
    if (result.changes === 0) {
      const exists = db.prepare('SELECT id, status FROM deliveries WHERE id = ?').get(id);
      if (!exists) return json(res, 404, { error: 'Delivery not found' });
      return json(res, 400, { error: `Delivery #${id} is not failed (status: ${exists.status})` });
    }
    log(`API: retry delivery #${id}`);
    return json(res, 200, { ok: true, delivery_id: id, status: 'pending' });
  }

  if (method === 'POST' && path === '/api/retry-all') {
    const result = qRetryAll.run();
    log(`API: retry-all, ${result.changes} deliveries reset`);
    return json(res, 200, { ok: true, retried: result.changes });
  }

  return json(res, 404, { error: 'Not found' });
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/webhook') {
      await handleWebhook(req, res);
    } else if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  } catch (err) {
    log(`Request error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT, 10) || 3100;

server.listen(PORT, HOST, () => {
  log(`Server listening on http://${HOST}:${PORT}`);
  config.watch();
  worker.start();
});
