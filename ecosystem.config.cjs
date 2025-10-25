/** @format */

module.exports = {
  apps: [
    {
      name: "cardgame-backend",
      script: "bun",
      args: "run dist/index.js",
      instances: 2, // หรือ "max"
      exec_mode: "cluster",
      env: {
        NODE_ENV: "production",
        PORT: 5000,
      },
      max_memory_restart: "500M",
      error_file: "./logs/backend-error.log",
      out_file: "./logs/backend-out.log",
      time: true,
      // Auto restart on crash
      autorestart: true,
      watch: false, // ปิด watch ใน production
      max_restarts: 10,
      min_uptime: "10s",
    },
  ],
};
