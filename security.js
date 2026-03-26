const crypto = require("crypto");

const DEFAULT_HASH_ALGORITHM = "sha256";
const DEFAULT_SALT_BYTES = 16;
const DEFAULT_ITERATIONS = 120000;
const DEFAULT_KEY_LENGTH = 32;

function hashSecret(secret) {
  const normalizedSecret = String(secret || "").trim();
  const salt = crypto.randomBytes(DEFAULT_SALT_BYTES).toString("hex");
  const derivedKey = crypto
    .pbkdf2Sync(
      normalizedSecret,
      salt,
      DEFAULT_ITERATIONS,
      DEFAULT_KEY_LENGTH,
      DEFAULT_HASH_ALGORITHM,
    )
    .toString("hex");

  return `pbkdf2$${DEFAULT_HASH_ALGORITHM}$${DEFAULT_ITERATIONS}$${salt}$${derivedKey}`;
}

function verifySecret(secret, secretHash) {
  if (!secretHash || !String(secretHash).startsWith("pbkdf2$")) {
    return false;
  }

  const normalizedSecret = String(secret || "").trim();
  const [, algorithm, iterationsValue, salt, expectedHash] = String(secretHash).split("$");
  const derivedKey = crypto
    .pbkdf2Sync(
      normalizedSecret,
      salt,
      Number(iterationsValue),
      DEFAULT_KEY_LENGTH,
      algorithm,
    )
    .toString("hex");

  return crypto.timingSafeEqual(
    Buffer.from(derivedKey, "hex"),
    Buffer.from(expectedHash, "hex"),
  );
}

function hashPin(pin) {
  return hashSecret(pin);
}

function verifyPin(pin, pinHash) {
  return verifySecret(pin, pinHash);
}

module.exports = {
  hashSecret,
  verifySecret,
  hashPin,
  verifyPin,
};
