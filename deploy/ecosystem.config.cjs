module.exports = {
  apps: [{
    name: 'pulse-server',
    script: 'src/server.js',
    cwd: '/srv/pulse/current/server',
    instances: 1,                 // Socket.IO presence is in-process; scale out only after adding the Redis adapter
    exec_mode: 'fork',
    max_memory_restart: '600M',
    kill_timeout: 20000,          // lets server.js shutdown() finish (15 s) on reload
    env: { NODE_ENV: 'production' },   // secrets come from /srv/pulse/shared/server.env via `--env-file` (see DEPLOY.md)
    node_args: '--env-file=/srv/pulse/shared/server.env',
    out_file: '/var/log/pulse/out.log', error_file: '/var/log/pulse/err.log', time: true,
  }],
};
