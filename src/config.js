const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

let config = { routes: {}, default: null };

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    config = {
      routes: parsed.routes || {},
      default: parsed.default || null
    };
    log(`Config loaded: ${Object.keys(config.routes).length} routes`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`[${new Date().toISOString()}] Config file not found: ${CONFIG_PATH}`);
    } else {
      console.error(`[${new Date().toISOString()}] Config load error: ${err.message}`);
    }
  }
}

function save() {
  const json = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(CONFIG_PATH, json, 'utf8');
  log(`Config saved: ${Object.keys(config.routes).length} routes`);
}

function watch() {
  fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
    log('Config file changed, reloading...');
    load();
  });
}

function getDestination(phoneNumber) {
  return config.routes[phoneNumber] || config.default || null;
}

function getConfig() {
  return { routes: { ...config.routes }, default: config.default };
}

function setRoute(phone, url) {
  config.routes[phone] = url;
  save();
}

function deleteRoute(phone) {
  const existed = phone in config.routes;
  delete config.routes[phone];
  if (existed) save();
  return existed;
}

function setDefault(url) {
  config.default = url;
  save();
}

// Load on require
load();

module.exports = { load, watch, getDestination, getConfig, setRoute, deleteRoute, setDefault };
