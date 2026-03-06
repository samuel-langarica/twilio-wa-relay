const querystring = require('node:querystring');
const db = require('./db');

const POLL_INTERVAL = 5000;
const BACKOFF_DELAYS = [0, 30, 120, 600, 3600]; // seconds
const FORWARD_TIMEOUT = 15000;

const fetchPending = db.prepare(`
  SELECT d.*, m.raw_payload
  FROM deliveries d
  JOIN messages m ON m.id = d.message_id
  WHERE d.status = 'pending'
    AND d.next_retry_at <= datetime('now')
  ORDER BY d.next_retry_at ASC
  LIMIT 10
`);

const claimDelivery = db.prepare(`
  UPDATE deliveries SET status = 'delivering', updated_at = datetime('now')
  WHERE id = ?
`);

const markDelivered = db.prepare(`
  UPDATE deliveries
  SET status = 'delivered',
      response_status = ?,
      response_body = ?,
      response_headers = ?,
      updated_at = datetime('now')
  WHERE id = ?
`);

const markRetry = db.prepare(`
  UPDATE deliveries
  SET status = 'pending',
      attempt_count = ?,
      next_retry_at = datetime('now', '+' || ? || ' seconds'),
      last_error = ?,
      response_status = ?,
      updated_at = datetime('now')
  WHERE id = ?
`);

const markFailed = db.prepare(`
  UPDATE deliveries
  SET status = 'failed',
      attempt_count = ?,
      last_error = ?,
      response_status = ?,
      updated_at = datetime('now')
  WHERE id = ?
`);

const logAttempt = db.prepare(`
  INSERT INTO delivery_attempts (delivery_id, attempt_number, status_code, error, response_body, response_headers)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const resetStale = db.prepare(`
  UPDATE deliveries SET status = 'pending' WHERE status = 'delivering'
`);

async function forward(url, payload) {
  const body = querystring.stringify(payload);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };

  if (process.env.WEBHOOK_SECRET) {
    headers['X-WhatsApp-Router-Secret'] = process.env.WEBHOOK_SECRET;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });
    const text = await res.text();
    const resHeaders = Object.fromEntries(res.headers.entries());
    return { status: res.status, body: text, headers: resHeaders };
  } finally {
    clearTimeout(timer);
  }
}

async function processDelivery(delivery) {
  claimDelivery.run(delivery.id);

  const attempt = delivery.attempt_count + 1;
  let payload;
  try {
    payload = JSON.parse(delivery.raw_payload);
  } catch (err) {
    markFailed.run(attempt, 'Invalid raw_payload JSON', null, delivery.id);
    return;
  }

  try {
    const result = await forward(delivery.destination_url, payload);
    const responseHeaders = JSON.stringify(result.headers);

    if (result.status >= 200 && result.status < 300) {
      markDelivered.run(result.status, result.body, responseHeaders, delivery.id);
      logAttempt.run(delivery.id, attempt, result.status, null, result.body, responseHeaders);
      console.log(`[${new Date().toISOString()}] Delivery #${delivery.id} succeeded (${result.status})`);
    } else {
      const error = `HTTP ${result.status}`;
      logAttempt.run(delivery.id, attempt, result.status, error, result.body, responseHeaders);
      handleFailure(delivery, attempt, error, result.status);
    }
  } catch (err) {
    const msg = err.name === 'AbortError' ? `Timeout (${FORWARD_TIMEOUT}ms)` : err.message;
    logAttempt.run(delivery.id, attempt, null, msg, null, null);
    handleFailure(delivery, attempt, msg, null);
  }
}

function handleFailure(delivery, attempt, error, status) {
  if (attempt >= delivery.max_attempts) {
    markFailed.run(attempt, error, status, delivery.id);
    console.warn(`[${new Date().toISOString()}] Delivery #${delivery.id} failed permanently after ${attempt} attempts: ${error}`);
  } else {
    const delay = BACKOFF_DELAYS[attempt] || 3600;
    markRetry.run(attempt, delay, error, status, delivery.id);
    console.warn(`[${new Date().toISOString()}] Delivery #${delivery.id} attempt ${attempt} failed (${error}), retrying in ${delay}s`);
  }
}

async function poll() {
  try {
    const pending = fetchPending.all();
    for (const delivery of pending) {
      await processDelivery(delivery);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Worker poll error: ${err.message}`);
  }
}

let intervalId = null;

function start() {
  const reset = resetStale.run();
  if (reset.changes > 0) {
    console.log(`[${new Date().toISOString()}] Worker: reset ${reset.changes} stale delivering entries`);
  }
  intervalId = setInterval(poll, POLL_INTERVAL);
  console.log(`[${new Date().toISOString()}] Delivery worker started (poll every ${POLL_INTERVAL / 1000}s)`);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { start, stop, forward, BACKOFF_DELAYS };
