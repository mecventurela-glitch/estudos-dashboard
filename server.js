// Painel de Estudos — servidor local (Node 18+, sem dependências externas)
// Cada matéria vira uma pasta em data/materias/<serie>-<nome>/ com arquivos legíveis.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const usuarios = require('./usuarios');

const PUBLIC_DIR = path.join(__dirname, 'public');
// Na Vercel o disco do projeto é somente leitura: usa /tmp (temporário) e o Postgres guarda o definitivo.
const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/estudos-data' : path.join(__dirname, 'data'));
const MATERIAS_DIR = path.join(DATA_DIR, 'materias');
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const NOME_COOKIE = 'sessao';
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const MAX_BODY = 30 * 1024 * 1024;

const SERIES = [
  { id: '8ano', label: '8º ano' },
  { id: '9ano', label: '9º ano' },
  { id: '1em', label: '1º ano do Ensino Médio' },
  { id: '2em', label: '2º ano do Ensino Médio' },
  { id: '3em', label: '3º ano do Ensino Médio' },
];
const CORES = ['#2563eb', '#16a34a', '#db2777', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8',
};
const SISTEMA_BASE = 'Você é um professor particular para alunos de uma escola adventista brasileira, do 8º ano ao 3º ano do Ensino Médio. Responda sempre em português do Brasil, de forma clara e didática, fiel ao conteúdo fornecido. Quando o tema tocar em religião, respeite a visão cristã adventista.';

try { fs.mkdirSync(MATERIAS_DIR, { recursive: true }); } catch (e) { console.error('Não consegui criar a pasta de dados:', e.message); }
usuarios.configurar({ arquivo: path.join(DATA_DIR, 'usuarios.json') });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- utilidades ----------
const agora = () => new Date().toISOString();
const hoje = () => new Date().toLocaleDateString('en-CA');
const novoId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
const ID_OK = /^[a-z0-9][a-z0-9_-]{0,80}$/i;
const DATA_OK = /^\d{4}-\d{2}-\d{2}$/;

function checarId(v) {
  if (!ID_OK.test(String(v))) throw new HttpError(400, 'Identificador inválido');
  return v;
}
function checarData(v) {
  if (!DATA_OK.test(String(v)) || isNaN(Date.parse(v))) throw new HttpError(400, 'Data inválida (use AAAA-MM-DD)');
  return v;
}
function lerJSON(file, padrao) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return padrao; }
}
function gravarJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function dirMateria(slug) {
  checarId(slug);
  const dir = path.join(MATERIAS_DIR, slug);
  if (!fs.existsSync(path.join(dir, 'materia.json'))) throw new HttpError(404, 'Matéria não encontrada');
  return dir;
}
const ordemSerie = (id) => SERIES.findIndex((s) => s.id === id);

// ---------- resumos (uma pasta por matéria, um arquivo .md por data) ----------
function lerResumos(dir) {
  const pasta = path.join(dir, 'resumos');
  if (!fs.existsSync(pasta)) return [];
  return fs.readdirSync(pasta)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort().reverse()
    .map((f) => {
      const raw = fs.readFileSync(path.join(pasta, f), 'utf8');
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const texto = (m ? m[2] : raw).replace(/^\n/, '').trim();
      const naProva = m ? /^na_prova:\s*true\s*$/m.test(m[1]) : false;
      return { data: f.slice(0, 10), naProva, texto, preview: texto.replace(/\s+/g, ' ').slice(0, 140) };
    });
}
function salvarResumo(dir, data, corpo) {
  const { texto, naProva } = corpo || {};
  const atual = lerResumos(dir).find((r) => r.data === data);
  const t = typeof texto === 'string' ? texto.trim() : (atual?.texto ?? '');
  const p = typeof naProva === 'boolean' ? naProva : (atual?.naProva ?? false);
  const arquivo = path.join(dir, 'resumos', `${data}.md`);
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, `---\ndata: ${data}\nna_prova: ${p}\natualizado: ${agora()}\n---\n\n${t}\n`);
  return { data, naProva: p, texto: t };
}

// ---------- provas (pasta por prova: páginas escaneadas + transcrição) ----------
function lerProvas(dir) {
  const pasta = path.join(dir, 'provas');
  if (!fs.existsSync(pasta)) return [];
  return fs.readdirSync(pasta, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const base = path.join(pasta, d.name);
      const info = lerJSON(path.join(base, 'prova.json'), null);
      if (!info) return null;
      const paginas = fs.readdirSync(base).filter((f) => /^pagina-\d+\.jpg$/.test(f)).sort();
      const texto = fs.existsSync(path.join(base, 'texto.md')) ? fs.readFileSync(path.join(base, 'texto.md'), 'utf8') : '';
      return { ...info, id: d.name, paginas, texto };
    })
    .filter(Boolean)
    .sort((a, b) => b.data.localeCompare(a.data));
}
function criarProva(dir, { nome, data }) {
  const n = String(nome || '').trim().slice(0, 80);
  if (!n) throw new HttpError(400, 'Informe o nome da prova');
  const d = checarData(data || hoje());
  const base = slugify(n) || 'prova';
  let id = `${d}-${base}`, k = 2;
  while (fs.existsSync(path.join(dir, 'provas', id))) id = `${d}-${base}-${k++}`;
  gravarJSON(path.join(dir, 'provas', id, 'prova.json'), { nome: n, data: d, criadoEm: agora() });
  return { id };
}
function adicionarPagina(dir, provaId, corpo) {
  checarId(provaId);
  const base = path.join(dir, 'provas', provaId);
  if (!fs.existsSync(path.join(base, 'prova.json'))) throw new HttpError(404, 'Prova não encontrada');
  const m = /^data:image\/jpeg;base64,(.+)$/s.exec(corpo?.imagem || '');
  if (!m) throw new HttpError(400, 'Imagem inválida (esperado JPEG)');
  const numeros = fs.readdirSync(base).filter((f) => /^pagina-\d+\.jpg$/.test(f)).map((f) => Number(f.match(/\d+/)[0]));
  const n = numeros.length ? Math.max(...numeros) + 1 : 1;
  const nome = `pagina-${String(n).padStart(2, '0')}.jpg`;
  fs.writeFileSync(path.join(base, nome), Buffer.from(m[1], 'base64'));
  return { arquivo: nome };
}

// ---------- texto-fonte para mapas e perguntas ----------
function textoDaFonte(dir, fonte) {
  let texto;
  if (fonte === 'todos' || fonte === 'na-prova') {
    const itens = lerResumos(dir).filter((r) => fonte === 'todos' || r.naProva);
    if (!itens.length) {
      throw new HttpError(400, fonte === 'todos'
        ? 'Ainda não há resumos nesta matéria.'
        : 'Nenhum resumo está marcado como "cai na prova".');
    }
    texto = itens.reverse().map((r) => `## Resumo de ${r.data}\n${r.texto}`).join('\n\n');
  } else if (typeof fonte === 'string' && fonte.startsWith('prova:')) {
    const f = path.join(dir, 'provas', checarId(fonte.slice(6)), 'texto.md');
    if (!fs.existsSync(f)) throw new HttpError(400, 'Essa prova ainda não foi lida com o Claude ("Ler com Claude").');
    texto = fs.readFileSync(f, 'utf8');
  } else {
    throw new HttpError(400, 'Escolha uma fonte válida');
  }
  return texto.slice(0, 40000);
}

// ---------- Claude ----------
async function claude({ system, content, maxTokens = 2000 }) {
  if (!API_KEY) {
    throw new HttpError(503, 'Defina a variável ANTHROPIC_API_KEY no servidor e reinicie para usar o Claude.');
  }
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    });
  } catch (e) {
    throw new HttpError(502, 'Não consegui falar com a API do Claude: ' + e.message);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, `Claude respondeu erro ${r.status}: ${data?.error?.message || ''}`);
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
function extrairJSON(texto) {
  const m = texto.match(/[\[{][\s\S]*[\]}]/);
  try { return JSON.parse(m?.[0] ?? ''); } catch { throw new HttpError(502, 'O Claude não devolveu JSON válido. Tente de novo.'); }
}

async function transcreverProva(dir, provaId) {
  checarId(provaId);
  const base = path.join(dir, 'provas', provaId);
  if (!fs.existsSync(base)) throw new HttpError(404, 'Prova não encontrada');
  const paginas = fs.readdirSync(base).filter((f) => /^pagina-\d+\.jpg$/.test(f)).sort();
  if (!paginas.length) throw new HttpError(400, 'Adicione páginas da prova antes de ler.');
  const content = paginas.slice(0, 12).map((f) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(path.join(base, f)).toString('base64') },
  }));
  content.push({
    type: 'text',
    text: 'Transcreva fielmente o texto destas páginas de prova, na ordem, em Markdown. Mantenha a numeração das questões e as alternativas. Não responda às questões.',
  });
  const texto = await claude({ system: SISTEMA_BASE, content, maxTokens: 4000 });
  fs.writeFileSync(path.join(base, 'texto.md'), texto);
  return { texto };
}

async function gerarMapa(dir, { fonte }) {
  const texto = textoDaFonte(dir, fonte);
  const json = extrairJSON(await claude({
    system: SISTEMA_BASE + ' Crie mapas mentais hierárquicos. Responda SOMENTE com JSON válido, sem texto fora dele, no formato {"titulo": "...", "raiz": {"texto": "...", "filhos": [{"texto": "...", "filhos": []}]}}. Use de 3 a 6 ramos principais, 2 a 5 subitens por ramo, textos curtos (até 8 palavras) e no máximo 3 níveis.',
    content: [{ type: 'text', text: `Crie o mapa mental do conteúdo abaixo:\n\n${texto}` }],
    maxTokens: 3000,
  }));
  if (!json?.raiz) throw new HttpError(502, 'O Claude não devolveu um mapa válido. Tente de novo.');
  const mapa = { id: novoId(), titulo: String(json.titulo || 'Mapa mental'), fonte, criadoEm: agora(), arvore: json.raiz };
  gravarJSON(path.join(dir, 'mapas', `${mapa.id}.json`), mapa);
  return mapa;
}

async function gerarPerguntas(dir, { fonte, quantidade }) {
  const n = Math.min(Math.max(Number(quantidade) || 10, 3), 25);
  const texto = textoDaFonte(dir, fonte);
  const lista = extrairJSON(await claude({
    system: SISTEMA_BASE + ' Crie perguntas de revisão para memorizar. Responda SOMENTE com um array JSON: [{"pergunta": "...", "resposta": "..."}]. Respostas curtas e objetivas (1 a 3 frases).',
    content: [{ type: 'text', text: `Gere ${n} perguntas com resposta a partir do conteúdo:\n\n${texto}` }],
    maxTokens: 3000,
  }));
  if (!Array.isArray(lista)) throw new HttpError(502, 'O Claude não devolveu a lista de perguntas. Tente de novo.');
  const novas = lista
    .filter((x) => x && x.pergunta && x.resposta)
    .map((x) => ({ id: novoId(), pergunta: String(x.pergunta), resposta: String(x.resposta), fonte, acertos: 0, erros: 0, criadoEm: agora() }));
  const arq = path.join(dir, 'perguntas.json');
  gravarJSON(arq, [...lerJSON(arq, []), ...novas]);
  return novas;
}

function atualizarPergunta(dir, id, { acertou }) {
  const arq = path.join(dir, 'perguntas.json');
  const lista = lerJSON(arq, []);
  const item = lista.find((x) => x.id === checarId(id));
  if (!item) throw new HttpError(404, 'Pergunta não encontrada');
  if (acertou === true) item.acertos++;
  else if (acertou === false) item.erros++;
  gravarJSON(arq, lista);
  return item;
}

async function perguntarDuvida(dir, { pergunta }) {
  const p = String(pergunta || '').trim();
  if (p.length < 3) throw new HttpError(400, 'Escreva ou fale a dúvida primeiro.');
  const contexto = lerResumos(dir).slice(0, 15)
    .map((r) => `## ${r.data}${r.naProva ? ' (cai na prova)' : ''}\n${r.texto}`)
    .join('\n\n').slice(0, 20000);
  const json = extrairJSON(await claude({
    system: SISTEMA_BASE + ' O aluno está com dúvida. Explique passo a passo, com exemplos simples. Responda SOMENTE com JSON no formato {"resposta": "...", "buscaYoutube": "termos curtos, em português, para achar uma videoaula sobre o assunto"}.',
    content: [{ type: 'text', text: `Resumos da matéria (use como referência quando for relevante):\n${contexto || '(sem resumos ainda)'}\n\nDúvida do aluno: ${p}` }],
    maxTokens: 2000,
  }));
  const duvida = {
    id: novoId(), pergunta: p, resposta: String(json.resposta || ''),
    buscaYoutube: String(json.buscaYoutube || p).slice(0, 120), videoUrl: null, criadoEm: agora(),
  };
  gravarJSON(path.join(dir, 'duvidas', `${duvida.id}.json`), duvida);
  return duvida;
}

function linkYoutube(v) {
  if (!v) return null;
  let u;
  try { u = new URL(String(v).trim()); } catch { throw new HttpError(400, 'Link inválido'); }
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') throw new HttpError(400, 'Use um link do YouTube');
  return u.toString();
}
function atualizarDuvida(dir, id, { videoUrl }) {
  const arq = path.join(dir, 'duvidas', `${checarId(id)}.json`);
  const duvida = lerJSON(arq, null);
  if (!duvida) throw new HttpError(404, 'Dúvida não encontrada');
  duvida.videoUrl = linkYoutube(videoUrl);
  gravarJSON(arq, duvida);
  return duvida;
}

// ---------- matérias ----------
function lerLista(pasta) {
  if (!fs.existsSync(pasta)) return [];
  return fs.readdirSync(pasta).filter((f) => f.endsWith('.json'))
    .map((f) => lerJSON(path.join(pasta, f), null)).filter(Boolean)
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}
function statsMateria(dir) {
  const contar = (sub) => {
    const p = path.join(dir, sub);
    return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => f.endsWith('.json')).length : 0;
  };
  const resumos = lerResumos(dir);
  return {
    resumos: resumos.length,
    naProva: resumos.filter((r) => r.naProva).length,
    provas: lerProvas(dir).length,
    mapas: contar('mapas'),
    perguntas: lerJSON(path.join(dir, 'perguntas.json'), []).length,
    duvidas: contar('duvidas'),
  };
}
function listarMaterias() {
  return fs.readdirSync(MATERIAS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(MATERIAS_DIR, d.name);
      const info = lerJSON(path.join(dir, 'materia.json'), null);
      return info && { ...info, slug: d.name, stats: statsMateria(dir) };
    })
    .filter(Boolean)
    .sort((a, b) => ordemSerie(a.serie) - ordemSerie(b.serie) || a.nome.localeCompare(b.nome, 'pt-BR'));
}
function criarMateria({ nome, serie }) {
  const n = String(nome || '').trim();
  if (n.length < 2 || n.length > 60) throw new HttpError(400, 'O nome deve ter de 2 a 60 caracteres');
  if (!SERIES.some((s) => s.id === serie)) throw new HttpError(400, 'Série inválida');
  if (!slugify(n)) throw new HttpError(400, 'Nome inválido');
  const slug = `${serie}-${slugify(n)}`;
  const dir = path.join(MATERIAS_DIR, slug);
  if (fs.existsSync(dir)) throw new HttpError(409, 'Essa matéria já existe nesta série');
  const info = { nome: n, serie, cor: CORES[hash(slug) % CORES.length], criadoEm: agora() };
  gravarJSON(path.join(dir, 'materia.json'), info);
  for (const p of ['resumos', 'provas', 'mapas', 'duvidas']) fs.mkdirSync(path.join(dir, p), { recursive: true });
  return { ...info, slug, stats: statsMateria(dir) };
}
function detalheMateria(slug) {
  const dir = dirMateria(slug);
  return {
    materia: { ...lerJSON(path.join(dir, 'materia.json'), {}), slug },
    stats: statsMateria(dir),
    resumos: lerResumos(dir),
    provas: lerProvas(dir),
    mapas: lerLista(path.join(dir, 'mapas')),
    perguntas: lerJSON(path.join(dir, 'perguntas.json'), []),
    duvidas: lerLista(path.join(dir, 'duvidas')),
  };
}

// ---------- HTTP ----------
const ROTAS = [
  ['GET', /^\/api\/series$/, () => SERIES],
  ['GET', /^\/api\/status$/, () => ({ banco: db.ativo() })],
  ['GET', /^\/api\/materias$/, () => listarMaterias()],
  ['POST', /^\/api\/materias$/, (_p, b) => criarMateria(b)],
  ['GET', /^\/api\/materias\/([^/]+)$/, ([s]) => detalheMateria(s)],
  ['PUT', /^\/api\/materias\/([^/]+)\/resumos\/([^/]+)$/, ([s, d], b) => salvarResumo(dirMateria(s), checarData(d), b)],
  ['POST', /^\/api\/materias\/([^/]+)\/provas$/, ([s], b) => criarProva(dirMateria(s), b)],
  ['POST', /^\/api\/materias\/([^/]+)\/provas\/([^/]+)\/paginas$/, ([s, pr], b) => adicionarPagina(dirMateria(s), pr, b)],
  ['POST', /^\/api\/materias\/([^/]+)\/provas\/([^/]+)\/transcrever$/, ([s, pr]) => transcreverProva(dirMateria(s), pr)],
  ['POST', /^\/api\/materias\/([^/]+)\/mapas$/, ([s], b) => gerarMapa(dirMateria(s), b)],
  ['POST', /^\/api\/materias\/([^/]+)\/perguntas$/, ([s], b) => gerarPerguntas(dirMateria(s), b)],
  ['PUT', /^\/api\/materias\/([^/]+)\/perguntas\/([^/]+)$/, ([s, id], b) => atualizarPergunta(dirMateria(s), id, b)],
  ['POST', /^\/api\/materias\/([^/]+)\/duvidas$/, ([s], b) => perguntarDuvida(dirMateria(s), b)],
  ['PUT', /^\/api\/materias\/([^/]+)\/duvidas\/([^/]+)$/, ([s, id], b) => atualizarDuvida(dirMateria(s), id, b)],
];

function enviar(res, status, body, type) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
const enviarJSON = (res, status, obj) => enviar(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let tam = 0;
    req.on('data', (c) => {
      tam += c.length;
      if (tam > MAX_BODY) { reject(new HttpError(413, 'Arquivo grande demais')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new HttpError(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

async function api(req, res, p) {
  let caminhoExiste = false;
  for (const [metodo, re, fn] of ROTAS) {
    const m = p.match(re);
    if (!m) continue;
    caminhoExiste = true;
    if (metodo !== req.method) continue;
    const corpo = req.method === 'GET' ? undefined : await lerCorpo(req);
    const resultado = await fn(m.slice(1), corpo);
    if (req.method !== 'GET' && db.ativo()) {
      // A gravação em arquivo já foi feita; agora copia a matéria para o Postgres.
      const slug = p.match(/^\/api\/materias\/([^/]+)/)?.[1] || resultado?.slug;
      if (slug) {
        try { await db.sincronizar(detalheMateria(slug), path.join(MATERIAS_DIR, slug)); }
        catch (e) {
          console.error('Falha ao gravar no banco:', e.message);
          throw new HttpError(500, 'Salvo no arquivo, mas falhou ao gravar no banco: ' + e.message);
        }
      }
    }
    return enviarJSON(res, 200, resultado ?? { ok: true });
  }
  if (caminhoExiste) return enviarJSON(res, 405, { erro: 'Método não permitido' });
  enviarJSON(res, 404, { erro: 'Rota não encontrada' });
}

function servirArquivo(res, file, base) {
  const resolvido = path.resolve(file);
  if (!resolvido.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(resolvido) || !fs.statSync(resolvido).isFile()) {
    return enviar(res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
  }
  enviar(res, 200, fs.readFileSync(resolvido), MIME[path.extname(resolvido)] || 'application/octet-stream');
}

let prontoBanco = null;
async function iniciarBanco() {
  if (DATABASE_URL) {
    await db.iniciar(DATABASE_URL, { ssl: process.env.DATABASE_SSL === 'true' });
    let n = 0;
    for (const m of listarMaterias()) { await db.sincronizar(detalheMateria(m.slug), path.join(MATERIAS_DIR, m.slug)); n++; }
    console.log(`Banco Postgres conectado. ${n} matéria(s) sincronizada(s).`);
  } else {
    console.log('DATABASE_URL não definida: os dados ficam só nos arquivos em data/.');
  }
  if (await usuarios.contar() === 0) {
    console.log('Aviso: nenhuma conta cadastrada. Crie uma com: node criar-usuario.js seu@email.com "sua senha"');
  }
}
// Inicializa uma vez (na Vercel, a cada instância nova da função). Tenta de novo se falhar.
function garantirPronto() {
  if (!prontoBanco) prontoBanco = iniciarBanco().catch((e) => { prontoBanco = null; throw e; });
  return prontoBanco;
}

// ---------- acesso por email e senha ----------
const ROTAS_PUBLICAS = ['/api/login', '/api/logout', '/api/eu'];
const TENTATIVAS = new Map(); // email -> { falhas, bloqueadoAte }
const MAX_FALHAS = 5;
const BLOQUEIO_MS = 15 * 60 * 1000;

function cookieSessao(req) {
  const cookies = String(req.headers.cookie || '').split(';').map((c) => c.trim());
  const achado = cookies.find((c) => c.startsWith(NOME_COOKIE + '='));
  return achado ? achado.slice(NOME_COOKIE.length + 1) : '';
}
function emailLogado(req) {
  return usuarios.emailDaSessao(cookieSessao(req));
}
function definirCookie(req, valor, maxAge) {
  const seguro = process.env.VERCEL ? '; Secure' : '';
  return `${NOME_COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${seguro}`;
}

async function fazerLogin(req, res) {
  const corpo = await lerCorpo(req);
  const email = usuarios.normalizarEmail(corpo.email) || String(corpo.email || '').trim().toLowerCase();
  const agora = Date.now();
  const tentativa = TENTATIVAS.get(email) || { falhas: 0, bloqueadoAte: 0 };
  if (tentativa.bloqueadoAte > agora) {
    throw new HttpError(429, 'Muitas tentativas. Espere alguns minutos e tente de novo.');
  }
  const ok = await usuarios.verificar(email, corpo.senha);
  if (!ok) {
    tentativa.falhas += 1;
    if (tentativa.falhas >= MAX_FALHAS) { tentativa.bloqueadoAte = agora + BLOQUEIO_MS; tentativa.falhas = 0; }
    TENTATIVAS.set(email, tentativa);
    throw new HttpError(401, 'Email ou senha incorretos');
  }
  TENTATIVAS.delete(email);
  const sessao = usuarios.criarSessao(ok);
  res.setHeader('set-cookie', definirCookie(req, sessao, Math.floor(usuarios.DURACAO_MS / 1000)));
  enviarJSON(res, 200, { ok: true, email: ok });
}

// Rotas de conta são tratadas antes da API comum. Devolve true se atendeu a requisição.
async function rotasDeConta(req, res, p) {
  if (p === '/api/login' && req.method === 'POST') { await fazerLogin(req, res); return true; }
  if (p === '/api/logout' && req.method === 'POST') {
    res.setHeader('set-cookie', definirCookie(req, '', 0));
    enviarJSON(res, 200, { ok: true });
    return true;
  }
  // Primeira conta: só funciona enquanto não existe nenhuma conta
  if (p === '/api/setup' && req.method === 'GET') {
    enviarJSON(res, 200, { precisaPrimeiraConta: (await usuarios.contar()) === 0 });
    return true;
  }
  if (p === '/api/primeira-conta' && req.method === 'POST') {
    if ((await usuarios.contar()) > 0) {
      throw new HttpError(403, 'Já existe uma conta. Peça para alguém logado criar a sua em "Criar acesso".');
    }
    const corpo = await lerCorpo(req);
    let email;
    try { email = await usuarios.criar(corpo.email, corpo.senha); }
    catch (e) { throw new HttpError(400, e.message); }
    res.setHeader('set-cookie', definirCookie(req, usuarios.criarSessao(email), Math.floor(usuarios.DURACAO_MS / 1000)));
    enviarJSON(res, 201, { ok: true, email });
    return true;
  }
  // Criar acesso para outra pessoa: só quem já entrou pode fazer isso
  if (p === '/api/usuarios' && req.method === 'POST') {
    if (!emailLogado(req)) throw new HttpError(401, 'Entre com seu email e senha');
    const corpo = await lerCorpo(req);
    let criado;
    try { criado = await usuarios.criar(corpo.email, corpo.senha); }
    catch (e) { throw new HttpError(400, e.message); }
    enviarJSON(res, 201, { ok: true, email: criado });
    return true;
  }
  if (p === '/api/eu' && req.method === 'GET') {
    const email = emailLogado(req);
    if (!email) throw new HttpError(401, 'Entre com seu email e senha');
    enviarJSON(res, 200, { email });
    return true;
  }
  return false;
}

async function handler(req, res) {
  try {
    if (process.env.VERCEL && !process.env.SESSION_SECRET) {
      return enviar(res, 503, 'Defina SESSION_SECRET nas variáveis do projeto na Vercel.', 'text/plain; charset=utf-8');
    }
    await garantirPronto();
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/') && await rotasDeConta(req, res, p)) return;
    const protegida = p.startsWith('/api/') || p.startsWith('/arquivos/');
    if (protegida && !ROTAS_PUBLICAS.includes(p) && !emailLogado(req)) {
      throw new HttpError(401, 'Entre com seu email e senha');
    }
    if (p.startsWith('/api/') || p.startsWith('/arquivos/')) {
      // Com banco, reconstrói os arquivos a partir do Postgres antes de responder.
      if (db.ativo()) await db.restaurar(MATERIAS_DIR);
    }
    if (p.startsWith('/api/')) return await api(req, res, p);
    if (p.startsWith('/arquivos/')) return servirArquivo(res, path.join(MATERIAS_DIR, p.slice('/arquivos/'.length)), MATERIAS_DIR);
    const rel = p === '/' ? '/index.html' : p;
    return servirArquivo(res, path.join(PUBLIC_DIR, rel), PUBLIC_DIR);
  } catch (e) {
    if (!e.status) console.error(e);
    enviarJSON(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno do servidor' });
  }
}

// Vercel importa este módulo e chama `handler`. Localmente, `node server.js` sobe o servidor.
module.exports = handler;

if (require.main === module) {
  http.createServer(handler).listen(PORT, () => {
    console.log(`Painel de Estudos em http://localhost:${PORT}`);
    console.log(`Dados em: ${DATA_DIR}`);
    if (!API_KEY) console.log('Aviso: ANTHROPIC_API_KEY não definida — o Claude (mapas, perguntas, dúvidas, leitura de prova) ficará indisponível.');
  });
  garantirPronto().catch((e) => {
    console.error('Não foi possível iniciar:', e.message);
    process.exit(1);
  });
}
