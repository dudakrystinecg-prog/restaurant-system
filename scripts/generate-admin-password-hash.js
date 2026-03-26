const { hashSecret } = require("../security");

const password = process.argv[2];

if (!password) {
  console.error('Uso: npm run hash:admin -- "SENHA_FORTE_AQUI"');
  process.exit(1);
}

console.log(hashSecret(password));
