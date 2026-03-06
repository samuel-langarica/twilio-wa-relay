module.exports = {
  apps: [{
    name: 'wa-relay',
    script: 'src/index.js',
    env: {
      NODE_ENV: 'production'
    },
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    watch: false
  }]
};
