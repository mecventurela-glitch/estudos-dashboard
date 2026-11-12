// Contas de acesso (email + senha). Com DATABASE_URL, ficam no Postgres (tabela usuarios);
// sem ela, ficam em <DATA_DIR>/usuarios.json. Senhas são guardadas com scrypt, nunca em texto puro.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

let arquivo = null;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function configurar({ arquivo: caminho }) { arquivo = caminho; }

function normalizarEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function confereSenha(senha, armazenado) {
  const [alg, saltHex, hashHex] = String(armazenado || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const atual = crypto.scryptSync(senha, Buffer.from(saltHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(atual, esperado);
}

// Hash fixo usado quando o email não existe, para a resposta demorar o mesmo tempo.
const HASH_FALSO = hashSenha('senha-falsa-para-tempo-constante');

function lerArquivo() {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return []; }
}

async function buscar(email) {
  if (db.ativo()) return db.buscarUsuario(email);
  return lerArquivo().find((u) => u.email === email) || null;
}

async function contar() {
  return db.ativo() ? db.contarUsuarios() : lerArquivo().length;
}

// Confere email e senha. Devolve o email normalizado ou null.
async function verificar(email, senha) {
  const e = normalizarEmail(email);
  const usuario = e ? await buscar(e) : null;
  const ok = confereSenha(String(senha || ''), usuario ? usuario.senhaHash : HASH_FALSO);
  return usuario && ok ? usuario.email : null;
}

async function criar(email, senha) {
  const e = normalizarEmail(email);
  if (!e) throw new Error('Email inválido');
  if (String(senha || '').length < 8) throw new Error('A senha deve ter pelo menos 8 caracteres');
  if (await buscar(e)) throw new Error('Já existe uma conta com esse email');
  const senhaHash = hashSenha(senha);
  if (db.ativo()) {
    await db.criarUsuarioDB(e, senhaHash);
  } else {
    const lista = lerArquivo();
    lista.push({ email: e, senhaHash, criadoEm: new Date().toISOString() });
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify(lista, null, 2));
  }
  return e;
}

// ---------- sessão: cookie assinado (HMAC) válido por 30 dias ----------
const DURACAO_MS = 30 * 24 * 60 * 60 * 1000;
// Na Vercel, defina SESSION_SECRET (senão cada instância gera um segredo diferente).
// Localmente, sem a variável, as sessões são invalidadas ao reiniciar o servidor.
const SEGREDO = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const assinar = (texto) => crypto.createHmac('sha256', SEGREDO).update(texto).digest('base64url');

function criarSessao(email) {
  const payload = Buffer.from(JSON.stringify({ e: email, x: Date.now() + DURACAO_MS })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

function emailDaSessao(valor) {
  const [payload, sig] = String(valor || '').split('.');
  if (!payload || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(assinar(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return dados.x > Date.now() ? dados.e : null;
  } catch { return null; }
}

module.exports = { configurar, normalizarEmail, verificar, criar, contar, criarSessao, emailDaSessao, DURACAO_MS };
