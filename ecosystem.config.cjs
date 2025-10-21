/** @format */
// ecosystem.config.cjs  (CommonJS)
module.exports = {
  apps: [
    {
      name: "api",
      cwd: "/home/backend",
      script: "bun",
      args: "run dev", // ใช้โปรดักชัน ไม่ใช้ dev
      env: {
        NODE_ENV: "production",
        PORT: "5000",
      },
      watch: false,
      autorestart: true,
      restart_delay: 3000, // กันรีสตาร์ทรัวๆถ้าล้ม
      instances: 1, // หรือ "max" ถ้าพร้อม scale
      exec_mode: "fork", // หรือ "cluster"
    },
  ],
  deploy: {
    production: {
      user: "SSH_USERNAME",
      host: "SSH_HOSTMACHINE",
      ref: "origin/master",
      repo: "GIT_REPOSITORY",
      path: "DESTINATION_PATH",
      "post-deploy": "bun install && bun run build && pm2 reload ecosystem.config.cjs --only api",
    },
  },
};
