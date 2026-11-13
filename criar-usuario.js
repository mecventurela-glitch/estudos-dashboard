// Cria uma conta de acesso ao painel.
// Uso: node criar-usuario.js seu@email.com "sua senha com 8+ caracteres"
// Com DATABASE_URL definida, a conta é gravada no Postgres (a mesma usada pelo app).
const db = require('./db');
const usuarios = require('./usuarios');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

async function main() {
  const [email, senha] = process.argv.slice(2);
  if (!email || !senha) {
    console.error('Uso: node criar-usuario.js seu@email.com "sua senha"');
    process.exit(1);
  }
  usuarios.configurar({ arquivo: path.join(DATA_DIR, 'usuarios.json') });
  const url = db.urlDoAmbiente();
  if (url) {
    await db.iniciar(url, { ssl: process.env.DATABASE_SSL === 'true' });
  }
  const criado = await usuarios.criar(email, senha);
  console.log(`Conta criada: ${criado}`);
  await db.fechar();
}

main().catch(async (e) => {
  console.error('Erro:', e.message);
  await db.fechar();
  process.exit(1);
});
