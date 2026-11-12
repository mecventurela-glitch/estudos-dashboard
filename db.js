// Espelho no Postgres. Os arquivos em data/materias/ continuam sendo a fonte principal;
// a cada gravação a matéria inteira é copiada para o banco (upsert, sem apagar nada).
// Ativo somente quando DATABASE_URL está definida.
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

// det = objeto retornado por detalheMateria(slug) em server.js
async function sincronizar(det) {
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

async function fechar() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { iniciar, sincronizar, ativo, fechar };
