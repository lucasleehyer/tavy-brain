module.exports = {
  apps: [{
    name: 'tavy-brain',
    script: 'dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    },
    error_file: '/dev/stderr',
    out_file: '/dev/stdout',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // Graceful shutdown
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 30000,
    
    // Restart strategy
    exp_backoff_restart_delay: 100,
    max_restarts: 10,
    restart_delay: 5000
  }]
};
