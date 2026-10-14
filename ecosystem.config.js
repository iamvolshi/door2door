// PM2 process file for VM deployments (DigitalOcean / Hetzner / EC2).
// Run `npm run build` first, then `pm2 start ecosystem.config.js`.
// NOTE: script is ./dist/main.js — the runnable entry. ./dist/index.js is a
// side-effect-free barrel (see src/index.ts) and never binds a port.
module.exports = {
  apps: [
    {
      name: 'cxb-delivery-backend',
      script: './dist/main.js',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 4000
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      time: true
    }
  ]
};
