// Postgres como fonte definitiva. Ativo somente quando DATABASE_URL está definida.
// - sincronizar(): copia uma matéria (textos e fotos das provas) para o banco após cada gravação.
// - restaurar(): reconstrói os arquivos em disco a partir do banco antes de atender requisições.
//   Assim o mesmo código de arquivos funciona na Vercel (disco temporário) e localmente.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS materias (
  slug        TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  serie       TEXT NOT NULL,
  cor         TEXT NOT NULL,
  criado_em   TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS resumos (
  materia_slug TEXT NOT NULL REFERENCES materias(slug) ON DELETE CASCADE,
  data         DATE NOT NULL,
  texto        TEXT NOT NULL,
  na_prova     BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (materia_slug, data)
);
CREATE TABLE IF NOT EXISTS provas (
  materia_slug TEXT NOT NULL REFERENCES materias(slug) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  nome         TEXT NOT NULL,
  data         DATE NOT NULL,
  paginas      JSONB NOT NULL DEFAULT '[]',
  transcricao  TEXT NOT NULL DEFAULT '',
  criado_em    TIMESTAMPTZ,
  PRIMARY KEY (materia_slug, id)
);
CREATE TABLE IF NOT EXISTS paginas (
  materia_slug TEXT NOT NULL REFERENCES materias(slug) ON DELETE CASCADE,
  prova_id     TEXT NOT NULL,
  nome         TEXT NOT NULL,
  conteudo     BYTEA NOT NULL,
  PRIMARY KEY (materia_slug, prova_id, nome)
);
CREATE TABLE IF NOT EXISTS mapas (
  id           TEXT PRIMARY KEY,
  materia_slug TEXT NOT NULL REFERENCES materias(slug) ON DELETE CASCADE,
  titulo       TEXT NOT NULL,
  fonte        TEXT NOT NULL,
  arvore       JSONB NOT NULL,
  criado_em    TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS perguntas (
  id           TEXT PRIMARY KEY,
  materia_slug TEXT NOT NULL REFERENCES materias(slug) ON DELETE CASCADE,
  pergunta     TEXT NOT NULL,
  resposta     TEXT NOT NULL,
  fonte        TEXT NOT NULL,
  acertos      INTEGER NOT NULL DEFAULT 0,
  erros        INTEGER NOT NULL DEFAULT 0,
  criado_em    TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS duvidas (
  id            TEXT PRIMARY KEY,
  materia_slug  TEXT NOT NULL REFERENCES materias(slug) ON DELETE CASCADE,
  pergunta      TEXT NOT NULL,
  resposta      TEXT NOT NULL,
  busca_youtube TEXT NOT NULL DEFAULT '',
  video_url     TEXT,
  criado_em     TIMESTAMPTZ NOT NULL
);
`;

const ativo = () => pool !== null;

async function iniciar(url, { ssl } = {}) {
  pool = new Pool({ connectionString: url, max: 5, ssl: ssl ? { rejectUnauthorized: false } : undefined });
  await pool.query(SCHEMA);
}

// det = detalheMateria(slug); matDir = pasta da matéria em disco
async function sincronizar(det, matDir) {
  if (!pool) return;
  const { materia, resumos, provas, mapas, perguntas, duvidas } = det;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO materias (slug, nome, serie, cor, criado_em) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (slug) DO UPDATE SET nome=EXCLUDED.nome, serie=EXCLUDED.serie, cor=EXCLUDED.cor`,
      [materia.slug, materia.nome, materia.serie, materia.cor, materia.criadoEm || new Date()]
    );
    for (const r of resumos) {
      await c.query(
        `INSERT INTO resumos (materia_slug, data, texto, na_prova) VALUES ($1,$2,$3,$4)
         ON CONFLICT (materia_slug, data) DO UPDATE SET texto=EXCLUDED.texto, na_prova=EXCLUDED.na_prova`,
        [materia.slug, r.data, r.texto, r.naProva]
      );
    }
    for (const p of provas) {
      await c.query(
        `INSERT INTO provas (materia_slug, id, nome, data, paginas, transcricao, criado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (materia_slug, id) DO UPDATE SET nome=EXCLUDED.nome, data=EXCLUDED.data,
           paginas=EXCLUDED.paginas, transcricao=EXCLUDED.transcricao`,
        [materia.slug, p.id, p.nome, p.data, JSON.stringify(p.paginas), p.texto, p.criadoEm || null]
      );
    }
    // Fotos: envia só as que ainda não estão no banco
    const { rows: jaTem } = await c.query('SELECT prova_id, nome FROM paginas WHERE materia_slug=$1', [materia.slug]);
    const existentes = new Set(jaTem.map((r) => `${r.prova_id}/${r.nome}`));
    for (const p of provas) {
      for (const nome of p.paginas) {
        if (existentes.has(`${p.id}/${nome}`)) continue;
        const bytes = fs.readFileSync(path.join(matDir, 'provas', p.id, nome));
        await c.query(
          'INSERT INTO paginas (materia_slug, prova_id, nome, conteudo) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [materia.slug, p.id, nome, bytes]
        );
      }
    }
    for (const m of mapas) {
      await c.query(
        `INSERT INTO mapas (id, materia_slug, titulo, fonte, arvore, criado_em) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET titulo=EXCLUDED.titulo, arvore=EXCLUDED.arvore`,
        [m.id, materia.slug, m.titulo, m.fonte, JSON.stringify(m.arvore), m.criadoEm]
      );
    }
    for (const q of perguntas) {
      await c.query(
        `INSERT INTO perguntas (id, materia_slug, pergunta, resposta, fonte, acertos, erros, criado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET acertos=EXCLUDED.acertos, erros=EXCLUDED.erros,
           pergunta=EXCLUDED.pergunta, resposta=EXCLUDED.resposta`,
        [q.id, materia.slug, q.pergunta, q.resposta, q.fonte, q.acertos, q.erros, q.criadoEm]
      );
    }
    for (const d of duvidas) {
      await c.query(
        `INSERT INTO duvidas (id, materia_slug, pergunta, resposta, busca_youtube, video_url, criado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET video_url=EXCLUDED.video_url, resposta=EXCLUDED.resposta`,
        [d.id, materia.slug, d.pergunta, d.resposta, d.buscaYoutube || '', d.videoUrl || null, d.criadoEm]
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Reconstrói em disco (materiasDir/<slug>/...) o que está no banco. Textos são reescritos;
// fotos só são baixadas quando o arquivo ainda não existe.
async function restaurar(materiasDir) {
  if (!pool) return;
  const escreverJSON = (file, obj) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  };
  const iso = (d) => (d ? new Date(d).toISOString() : null);

  const { rows: mats } = await pool.query('SELECT slug, nome, serie, cor, criado_em FROM materias');
  for (const m of mats) {
    const base = path.join(materiasDir, m.slug);
    for (const sub of ['resumos', 'provas', 'mapas', 'duvidas']) fs.mkdirSync(path.join(base, sub), { recursive: true });
    escreverJSON(path.join(base, 'materia.json'), { nome: m.nome, serie: m.serie, cor: m.cor, criadoEm: iso(m.criado_em) });
  }

  const { rows: res } = await pool.query("SELECT materia_slug, to_char(data,'YYYY-MM-DD') AS data, texto, na_prova FROM resumos");
  for (const r of res) {
    const file = path.join(materiasDir, r.materia_slug, 'resumos', `${r.data}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\ndata: ${r.data}\nna_prova: ${r.na_prova}\n---\n\n${r.texto}\n`);
  }

  const { rows: provas } = await pool.query(
    "SELECT materia_slug, id, nome, to_char(data,'YYYY-MM-DD') AS data, paginas, transcricao, criado_em FROM provas"
  );
  for (const p of provas) {
    const base = path.join(materiasDir, p.materia_slug, 'provas', p.id);
    escreverJSON(path.join(base, 'prova.json'), { nome: p.nome, data: p.data, criadoEm: iso(p.criado_em) });
    if (p.transcricao) fs.writeFileSync(path.join(base, 'texto.md'), p.transcricao);
    for (const nome of p.paginas) {
      const file = path.join(base, nome);
      if (fs.existsSync(file)) continue;
      const { rows } = await pool.query(
        'SELECT conteudo FROM paginas WHERE materia_slug=$1 AND prova_id=$2 AND nome=$3',
        [p.materia_slug, p.id, nome]
      );
      if (rows[0]) { fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(file, rows[0].conteudo); }
    }
  }

  const { rows: mapas } = await pool.query('SELECT id, materia_slug, titulo, fonte, arvore, criado_em FROM mapas');
  for (const m of mapas) {
    escreverJSON(path.join(materiasDir, m.materia_slug, 'mapas', `${m.id}.json`),
      { id: m.id, titulo: m.titulo, fonte: m.fonte, criadoEm: iso(m.criado_em), arvore: m.arvore });
  }

  const { rows: perg } = await pool.query('SELECT * FROM perguntas ORDER BY criado_em');
  const porMateria = {};
  for (const q of perg) {
    (porMateria[q.materia_slug] ||= []).push({
      id: q.id, pergunta: q.pergunta, resposta: q.resposta, fonte: q.fonte,
      acertos: q.acertos, erros: q.erros, criadoEm: iso(q.criado_em),
    });
  }
  for (const [slug, lista] of Object.entries(porMateria)) {
    escreverJSON(path.join(materiasDir, slug, 'perguntas.json'), lista);
  }

  const { rows: duv } = await pool.query('SELECT * FROM duvidas');
  for (const d of duv) {
    escreverJSON(path.join(materiasDir, d.materia_slug, 'duvidas', `${d.id}.json`),
      { id: d.id, pergunta: d.pergunta, resposta: d.resposta, buscaYoutube: d.busca_youtube,
        videoUrl: d.video_url, criadoEm: iso(d.criado_em) });
  }
}

async function fechar() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { iniciar, sincronizar, restaurar, ativo, fechar };
