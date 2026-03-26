const path = require("path");
const { hashSecret } = require("./security");

const isProduction = process.env.NODE_ENV === "production";
const rootDirectory = __dirname;
const frontendBuildPath = path.join(rootDirectory, "kiosk", "build");
const defaultAdminPasswordHash =
  "pbkdf2$sha256$120000$29bb6e57ae8a5a9c8cedbc615001302b$94808a97f370f05491829be9cb13deb61435aee5a3ede2dc703c8f9ccc92d311";

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveAdminPasswordHash() {
  if (process.env.ADMIN_PASSWORD_HASH) {
    return process.env.ADMIN_PASSWORD_HASH;
  }

  if (isProduction) {
    throw new Error(
      "ADMIN_PASSWORD_HASH e obrigatorio em producao. Gere um hash seguro e configure a variavel antes de iniciar o servidor.",
    );
  }

  if (process.env.ADMIN_PASSWORD) {
    return hashSecret(process.env.ADMIN_PASSWORD);
  }

  return defaultAdminPasswordHash;
}

const config = {
  isProduction,
  port: readNumberEnv("PORT", 3001),
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
  frontendBuildPath,
  databasePath:
    process.env.DATABASE_PATH ||
    path.join(rootDirectory, "data", "restaurant-system.db"),
  admin: {
    username: process.env.ADMIN_USERNAME || "admin",
    passwordHash: resolveAdminPasswordHash(),
    sessionTtlMs: readNumberEnv("ADMIN_SESSION_TTL_MS", 1000 * 60 * 60 * 8),
    loginRateLimitMaxAttempts: readNumberEnv(
      "ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS",
      5,
    ),
    loginRateLimitWindowMs: readNumberEnv(
      "ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS",
      1000 * 60 * 15,
    ),
  },
  audit: {
    retentionDays: readNumberEnv("AUDIT_LOG_RETENTION_DAYS", 365),
  },
};

module.exports = config;
