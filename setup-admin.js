require("dotenv").config();
const { hashSecret } = require("./security");
const { initializeDatabase, createAdminUser, findAdminUserByEmail, countAdminUsers } = require("./db");

initializeDatabase();

const USERS = [
  { name: "Admin", email: "dudakrystinecg@gmail.com", password: "admin123" },
];

for (const user of USERS) {
  try {
    const existing = findAdminUserByEmail(user.email);
    if (existing) {
      console.log(`Skipping ${user.email} — already exists`);
      continue;
    }
    const passwordHash = hashSecret(user.password);
    createAdminUser({ name: user.name, email: user.email, passwordHash, role: "super_admin" });
    console.log(`Created admin user: ${user.name} <${user.email}>`);
  } catch (err) {
    console.error(`Failed to create ${user.email}:`, err.message);
  }
}

console.log(`\nTotal active admin users: ${countAdminUsers()}`);
process.exit(0);
