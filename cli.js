#!/usr/bin/env node

const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const dbPath = path.join(__dirname, 'data', 'webhook.db');
const configPath = path.join(__dirname, 'config.json');

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (err) {
  console.error(`Cannot open database: ${err.message}`);
  process.exit(1);
}

const [,, command, ...args] = process.argv;

const commands = {
  status() {
    const msgs = db.prepare('SELECT COUNT(*) as count FROM messages').get();
    const deliveries = db.prepare(`
      SELECT status, COUNT(*) as count FROM deliveries GROUP BY status
    `).all();

    console.log(`\nMessages: ${msgs.count}`);
    console.log('\nDeliveries:');
    if (deliveries.length === 0) {
      console.log('  (none)');
    } else {
      for (const d of deliveries) {
        console.log(`  ${d.status}: ${d.count}`);
      }
    }

    const recent = db.prepare(`
      SELECT created_at FROM messages ORDER BY id DESC LIMIT 1
    `).get();
    if (recent) {
      console.log(`\nLast message: ${recent.created_at}`);
    }
    console.log();
  },

  messages() {
    const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1], 10) || 20;
    const rows = db.prepare(`
      SELECT m.id, m.from_number, m.body, m.created_at,
             d.status as delivery_status, d.destination_url
      FROM messages m
      LEFT JOIN deliveries d ON d.message_id = m.id
      ORDER BY m.id DESC
      LIMIT ?
    `).all(limit);

    if (rows.length === 0) {
      console.log('\nNo messages found.\n');
      return;
    }

    console.log();
    for (const r of rows) {
      const body = (r.body || '').slice(0, 60);
      const status = r.delivery_status || 'no-delivery';
      console.log(`#${r.id} [${r.created_at}] ${r.from_number} → ${r.destination_url || '?'} (${status})`);
      if (body) console.log(`   ${body}`);
    }
    console.log();
  },

  failed() {
    const rows = db.prepare(`
      SELECT d.id, d.message_id, d.destination_url, d.attempt_count, d.last_error, d.updated_at,
             m.from_number, m.body
      FROM deliveries d
      JOIN messages m ON m.id = d.message_id
      WHERE d.status = 'failed'
      ORDER BY d.updated_at DESC
      LIMIT 50
    `).all();

    if (rows.length === 0) {
      console.log('\nNo failed deliveries.\n');
      return;
    }

    console.log(`\n${rows.length} failed deliveries:\n`);
    for (const r of rows) {
      const body = (r.body || '').slice(0, 40);
      console.log(`  Delivery #${r.id} (msg #${r.message_id}) → ${r.destination_url}`);
      console.log(`    From: ${r.from_number} | Attempts: ${r.attempt_count} | ${r.updated_at}`);
      console.log(`    Error: ${r.last_error}`);
      if (body) console.log(`    Body: ${body}`);
      console.log();
    }
  },

  retry() {
    const id = parseInt(args[0], 10);
    if (!id) {
      console.error('Usage: node cli.js retry <delivery_id>');
      process.exit(1);
    }

    // Reopen writable
    const wdb = new Database(dbPath);
    const delivery = wdb.prepare('SELECT * FROM deliveries WHERE id = ?').get(id);
    if (!delivery) {
      console.error(`Delivery #${id} not found`);
      process.exit(1);
    }
    if (delivery.status !== 'failed') {
      console.error(`Delivery #${id} is not failed (status: ${delivery.status})`);
      process.exit(1);
    }

    wdb.prepare(`
      UPDATE deliveries
      SET status = 'pending', attempt_count = 0, next_retry_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    wdb.close();
    console.log(`Delivery #${id} reset to pending. Worker will retry on next poll.`);
  },

  'retry-all'() {
    const wdb = new Database(dbPath);
    const result = wdb.prepare(`
      UPDATE deliveries
      SET status = 'pending', attempt_count = 0, next_retry_at = datetime('now'), updated_at = datetime('now')
      WHERE status = 'failed'
    `).run();
    wdb.close();
    console.log(`${result.changes} failed deliveries reset to pending.`);
  },

  routes() {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const cfg = JSON.parse(raw);
      const routes = cfg.routes || {};
      const keys = Object.keys(routes);

      console.log();
      if (keys.length === 0) {
        console.log('No routes configured.');
      } else {
        console.log(`${keys.length} routes:\n`);
        for (const phone of keys) {
          console.log(`  ${phone} → ${routes[phone]}`);
        }
      }

      if (cfg.default) {
        console.log(`\n  Default: ${cfg.default}`);
      }
      console.log();
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.error(`Config file not found: ${configPath}`);
      } else {
        console.error(`Error reading config: ${err.message}`);
      }
      process.exit(1);
    }
  },

  help() {
    console.log(`
Usage: node cli.js <command>

Commands:
  status              Message/delivery stats
  messages [--limit=N] Recent messages (default: 20)
  failed              Failed deliveries
  retry <id>          Retry a failed delivery
  retry-all           Retry all failed deliveries
  routes              Show current routes from config.json
  help                Show this help
`);
  }
};

if (!command || !commands[command]) {
  if (command) console.error(`Unknown command: ${command}\n`);
  commands.help();
  process.exit(command ? 1 : 0);
}

commands[command]();
