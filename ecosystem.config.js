module.exports = {
  apps: [
    {
      name: "restaurant-system",
      script: "server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        PORT: 3001,
        FRONTEND_ORIGIN: "https://restaurant-system.example.com",
        DATABASE_PATH: "/var/www/restaurant-system/shared/restaurant-system.db",
        ADMIN_SESSION_TTL_MS: 28800000,
        ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: 5,
        ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS: 900000,
        AUDIT_LOG_RETENTION_DAYS: 365,
      },
      env_production: {
        NODE_ENV: "production",
      },
      out_file: "/var/log/restaurant-system/out.log",
      error_file: "/var/log/restaurant-system/error.log",
      time: true,
    },
  ],
};
