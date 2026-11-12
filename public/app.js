// Painel de Estudos — interface (vanilla JS)
const app = document.getElementById('app');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hoje = () => new Date().toLocaleDateString('en-CA');
const dataBR = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : new Date(s).toLocaleDateString('pt-BR'));
const rotuloFonte = (f) => (f === 'na-prova' ? 'resumos da prova' : f === 'todos' ? 'todos os resumos' : 'prova lida');
const SUGESTOES = ['Matemática', 'Português', 'Literatura', 'Redação', 'História', 'Geografia', 'Ciências', 'Biologia', 'Física', 'Química', 'Inglês', 'Espanhol', 'Bíblia', 'Filosofia', 'Sociologia', 'Educação Física', 'Artes'];
const ABAS = { resumos: '📝 Resumos', prova: '📄 Prova & Scanner', mapas: '🧠 Mapas mentais', perguntas: '🃏 Perguntas', duvidas: '🎤 Dúvidas (voz)' };

let SERIES = [];
let cur = { slug: null, tab: 'resumos' };
let cache = null;
let reconhecimento = null;
let camStream = null;

// ---------- base ----------
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch('/api' + url, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !['/login', '/eu'].includes(url)) { mostrarLogin(); throw new Error('Sessão expirada. Entre de novo.'); }
  if (!r.ok) throw new Error(data.erro || `Erro ${r.status}`);
  return data;
}

// ---------- acesso (email + senha) ----------
function viewAcesso() {
  app.innerHTML = `
  <section class="card login">
    <h2>Criar acesso</h2>
    <p class="muted">Crie a conta de quem vai usar o painel. Todas as contas veem os mesmos dados.</p>
    <form id="fAcesso">
      <label>Email <input type="email" name="email" autocomplete="off" required></label>
      <label>Senha inicial (mínimo 8 caracteres) <input type="password" name="senha" autocomplete="new-password" minlength="8" required></label>
      <button class="btn" type="submit" id="btnAcesso">Criar acesso</button>
      <p class="erro" id="acessoErro" hidden></p>
    </form>
  </section>`;
  $('#fAcesso').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const btn = $('#btnAcesso');
    btn.disabled = true;
    try {
      const r = await api('POST', '/usuarios', { email: f.get('email'), senha: f.get('senha') });
      toast(`Conta criada: ${r.email}`);
      e.currentTarget.reset();
      $('#acessoErro').hidden = true;
    } catch (err) {
      $('#acessoErro').textContent = err.message;
      $('#acessoErro').hidden = false;
    } finally {
      btn.disabled = false;
    }
  };
}

function mostrarLogin(erro = '') {
  $('#sair').hidden = true;
  $('#acessoBtn').hidden = true;
  app.innerHTML = `
  <section class="card login">
    <h2>Entrar</h2>
    <form id="fLogin">
      <label>Email <input type="email" name="email" autocomplete="username" required></label>
      <label>Senha <input type="password" name="senha" autocomplete="current-password" required></label>
      <button class="btn" type="submit" id="btnEntrar">Entrar</button>
      <p class="erro" id="loginErro" ${erro ? '' : 'hidden'}>${esc(erro)}</p>
    </form>
  </section>`;
  $('#fLogin').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const btn = $('#btnEntrar');
    btn.disabled = true;
    try {
      await api('POST', '/login', { email: f.get('email'), senha: f.get('senha') });
      location.hash = '#/';
      await route();
    } catch (err) {
      btn.disabled = false;
      $('#loginErro').textContent = err.message;
      $('#loginErro').hidden = false;
    }
  };
}
async function sessaoAtiva() {
  try { await api('GET', '/eu'); return true; } catch { return false; }
}
$('#sair').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  cache = null;
  mostrarLogin();
};
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
async function acao(btn, textoBusy, fn) {
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = textoBusy; }
  try { return await fn(); }
  catch (e) { toast('⚠️ ' + e.message, 6000); }
  finally { if (btn) { btn.disabled = false; btn.textContent = original; } }
}
const nomeSerie = (id) => SERIES.find((s) => s.id === id)?.label || id;
const lerArquivo = (file) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, 2000 / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(img.src);
    resolve(cv.toDataURL('image/jpeg', 0.88));
  };
  img.onerror = () => reject(new Error('Não consegui abrir ' + file.name));
  img.src = URL.createObjectURL(file);
});
function ditar(btn, alvo) {
  if (reconhecimento) return reconhecimento.stop();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Reconhecimento de voz indisponível. Use Chrome ou Edge.');
  const rec = new SR();
  rec.lang = 'pt-BR'; rec.interimResults = true; rec.continuous = true;
  const rotulo = btn.textContent;
  const base = alvo.value ? alvo.value.trimEnd() + ' ' : '';
  rec.onresult = (e) => {
    let t = '';
    for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
    alvo.value = base + t;
  };
  rec.onstart = () => { btn.classList.add('gravando'); btn.textContent = '⏹ Parar'; };
  rec.onend = () => { reconhecimento = null; btn.classList.remove('gravando'); btn.textContent = rotulo; };
  rec.onerror = (e) => toast('Microfone: ' + e.error);
  reconhecimento = rec;
  rec.start();
}
function falar(texto) {
  if (!('speechSynthesis' in window)) return toast('Seu navegador não lê em voz alta.');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(texto);
  u.lang = 'pt-BR';
  speechSynthesis.speak(u);
}
const videoId = (url) => (url || '').match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/)?.[1] || null;

// ---------- roteamento ----------
window.addEventListener('hashchange', route);
async function route() {
  fecharCamera();
  const [, root, slug, tab] = location.hash.replace(/^#/, '').split('/');
  if (!(await sessaoAtiva())) return mostrarLogin();
  $('#sair').hidden = false;
  $('#acessoBtn').hidden = false;
  try {
    if (!SERIES.length) SERIES = await api('GET', '/series');
    if (root === 'acesso') viewAcesso();
    else if (root === 'm' && slug) await viewMateria(slug, tab);
    else await viewHome();
  } catch (e) {
    app.innerHTML = `<p class="erro">${esc(e.message)}</p>`;
  }
}

// ---------- início ----------
function cardMateria(m) {
  const s = m.stats;
  return `<a class="materia" href="#/m/${esc(m.slug)}/resumos" style="--cor:${esc(m.cor)}">
    <strong>${esc(m.nome)}</strong>
    <span class="muted">${esc(nomeSerie(m.serie))}</span>
    <div class="mini">📝 ${s.resumos} resumo(s) · ⭐ ${s.naProva} na prova<br>
    📄 ${s.provas} prova(s) · 🧠 ${s.mapas} mapa(s) · 🃏 ${s.perguntas} cartões · 🎤 ${s.duvidas} dúvida(s)</div>
  </a>`;
}
async function viewHome() {
  const materias = await api('GET', '/materias');
  app.innerHTML = `
  <section class="hero">
    <div><h1>Painel de estudos</h1>
      <p>${materias.length} matéria(s) cadastrada(s). Resumos, provas, mapas mentais, perguntas e dúvidas com o Claude, cada um na pasta da sua matéria.</p></div>
    <button class="btn" id="btnNova">+ Nova matéria</button>
  </section>
  <section class="card" id="formNova" hidden>
    <h2>Cadastrar matéria</h2>
    <form id="fMateria" class="linha">
      <select name="serie" required>${SERIES.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select>
      <input name="nome" placeholder="Nome da matéria" required maxlength="60">
      <button class="btn">Cadastrar</button>
    </form>
    <div class="chips">${SUGESTOES.map((n) => `<button type="button" class="chip" data-nome="${esc(n)}">${esc(n)}</button>`).join('')}</div>
  </section>
  ${SERIES.map((s) => {
    const itens = materias.filter((m) => m.serie === s.id);
    return `<section class="serie"><h2>${esc(s.label)}</h2>
      <div class="grid">${itens.length ? itens.map(cardMateria).join('') : '<p class="vazio">Nenhuma matéria ainda.</p>'}</div></section>`;
  }).join('')}`;

  $('#btnNova').onclick = () => { const f = $('#formNova'); f.hidden = !f.hidden; };
  $$('.chip').forEach((c) => (c.onclick = () => { $('#fMateria [name=nome]').value = c.dataset.nome; }));
  $('#fMateria').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const m = await api('POST', '/materias', { serie: fd.get('serie'), nome: fd.get('nome') });
      toast('Matéria cadastrada!');
      location.hash = `#/m/${m.slug}/resumos`;
    } catch (err) { toast('⚠️ ' + err.message); }
  };
}

// ---------- matéria ----------
const TABS = { resumos: tabResumos, prova: tabProva, mapas: tabMapas, perguntas: tabPerguntas, duvidas: tabDuvidas };

async function viewMateria(slug, tab) {
  cur = { slug, tab: TABS[tab] ? tab : 'resumos' };
  cache = await api('GET', `/materias/${slug}`);
  const m = cache.materia;
  app.innerHTML = `
    <nav class="voltar"><a href="#/">← Painel</a></nav>
    <header class="cab" style="--cor:${esc(m.cor)}"><h1>${esc(m.nome)}</h1><span class="muted">${esc(nomeSerie(m.serie))}</span></header>
    <nav class="abas">${Object.entries(ABAS).map(([k, v]) => `<a href="#/m/${slug}/${k}" class="${k === cur.tab ? 'ativa' : ''}">${v}</a>`).join('')}</nav>
    <div id="conteudo"></div>`;
  TABS[cur.tab]();
}
async function refreshTab() {
  cache = await api('GET', `/materias/${cur.slug}`);
  TABS[cur.tab]();
}
function opcoesFonte() {
  const { resumos, provas } = cache;
  return [
    `<option value="na-prova">Resumos marcados para a prova (${resumos.filter((r) => r.naProva).length})</option>`,
    `<option value="todos">Todos os resumos (${resumos.length})</option>`,
    ...provas.filter((p) => p.texto).map((p) => `<option value="prova:${esc(p.id)}">Prova: ${esc(p.nome)} (${dataBR(p.data)})</option>`),
  ].join('');
}

// --- resumos ---
function tabResumos() {
  const { resumos } = cache;
  $('#conteudo').innerHTML = `
  <section class="card">
    <h2>Resumo do dia</h2>
    <div class="linha">
      <label>Data <input type="date" id="rData" value="${cur.data || hoje()}"></label>
      <label class="check"><input type="checkbox" id="rProva"> Cai na prova</label>
    </div>
    <textarea id="rTexto" rows="10" placeholder="Escreva o resumo da aula..."></textarea>
    <div class="linha">
      <button class="btn" id="rSalvar">💾 Salvar resumo</button>
      <button class="btn sec" id="rMic">🎤 Ditar</button>
    </div>
  </section>
  <section class="card">
    <h2>Resumos salvos <small>marque os que caem na prova</small></h2>
    ${resumos.length ? `<ul class="lista">${resumos.map((r) => `
      <li>
        <label class="check"><input type="checkbox" data-na-prova="${r.data}" ${r.naProva ? 'checked' : ''}> <strong>${dataBR(r.data)}</strong></label>
        <a href="#" data-abrir="${r.data}">${esc(r.preview)}…</a>
      </li>`).join('')}</ul>` : '<p class="vazio">Nenhum resumo ainda.</p>'}
  </section>`;

  const carregarDia = () => {
    const r = cache.resumos.find((x) => x.data === $('#rData').value);
    $('#rTexto').value = r?.texto || '';
    $('#rProva').checked = !!r?.naProva;
  };
  carregarDia();
  $('#rData').onchange = () => { cur.data = $('#rData').value; carregarDia(); };
  $('#rMic').onclick = (e) => ditar(e.currentTarget, $('#rTexto'));
  $('#rSalvar').onclick = (e) => acao(e.currentTarget, 'Salvando...', async () => {
    const data = $('#rData').value;
    await api('PUT', `/materias/${cur.slug}/resumos/${data}`, { texto: $('#rTexto').value, naProva: $('#rProva').checked });
    cur.data = data;
    toast('Resumo salvo na pasta da matéria ✔');
    await refreshTab();
  });
  $$('[data-na-prova]').forEach((cb) => (cb.onchange = async () => {
    await api('PUT', `/materias/${cur.slug}/resumos/${cb.dataset.naProva}`, { naProva: cb.checked });
    toast(cb.checked ? 'Marcado para a prova' : 'Desmarcado da prova');
    await refreshTab();
  }));
  $$('[data-abrir]').forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    cur.data = a.dataset.abrir;
    $('#rData').value = cur.data; carregarDia();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
}

// --- prova & scanner ---
function tabProva() {
  const { provas } = cache;
  $('#conteudo').innerHTML = `
  <section class="card">
    <h2>Nova prova</h2>
    <form id="fProva" class="linha">
      <input name="nome" placeholder="Ex.: Prova bimestral 1" required maxlength="80">
      <input type="date" name="data" value="${hoje()}" required>
      <button class="btn">Criar pasta da prova</button>
    </form>
  </section>
  ${provas.length ? provas.map((p) => `
  <section class="card">
    <div class="linha space">
      <h2>${esc(p.nome)} <small>${dataBR(p.data)}</small></h2>
      <div class="linha">
        <button class="btn sec" data-cam="${p.id}">📷 Escanear</button>
        <label class="btn sec">📁 Enviar fotos<input type="file" accept="image/*" multiple data-up="${p.id}" hidden></label>
        <button class="btn" data-ler="${p.id}" ${p.paginas.length ? '' : 'disabled'}>🔍 Ler com Claude</button>
      </div>
    </div>
    <div class="paginas">${p.paginas.length ? p.paginas.map((f) => `
      <a href="/arquivos/${cur.slug}/provas/${p.id}/${f}" target="_blank" rel="noopener"><img src="/arquivos/${cur.slug}/provas/${p.id}/${f}" alt="${esc(f)}" loading="lazy"></a>`).join('')
      : '<p class="vazio">Nenhuma página ainda. Escaneie com a câmera ou envie fotos.</p>'}</div>
    ${p.texto ? `<details><summary>Transcrição da prova</summary><pre>${esc(p.texto)}</pre></details>` : ''}
  </section>`).join('') : '<p class="vazio">Nenhuma prova cadastrada.</p>'}`;

  $('#fProva').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', `/materias/${cur.slug}/provas`, { nome: fd.get('nome'), data: fd.get('data') });
      toast('Prova criada na pasta da matéria');
      await refreshTab();
    } catch (err) { toast('⚠️ ' + err.message); }
  };
  $$('[data-cam]').forEach((b) => (b.onclick = () => abrirCamera(b.dataset.cam)));
  $$('[data-up]').forEach((inp) => (inp.onchange = async () => {
    const files = [...inp.files];
    let ok = 0;
    for (const f of files) {
      try {
        const imagem = await lerArquivo(f);
        await api('POST', `/materias/${cur.slug}/provas/${inp.dataset.up}/paginas`, { imagem });
        ok++;
      } catch (err) { toast('⚠️ ' + err.message); }
    }
    if (ok) toast(`${ok} página(s) salva(s)`);
    await refreshTab();
  }));
  $$('[data-ler]').forEach((b) => (b.onclick = () => acao(b, '🔍 Lendo prova...', async () => {
    await api('POST', `/materias/${cur.slug}/provas/${b.dataset.ler}/transcrever`);
    toast('Prova transcrita. Já pode gerar mapas e perguntas a partir dela.');
    await refreshTab();
  })));
}

// câmera
async function abrirCamera(provaId) {
  const modal = $('#modal');
  modal.hidden = false;
  modal.innerHTML = `<div class="janela">
    <div class="linha space"><strong>Escanear página da prova</strong><button class="btn sec pequeno" id="camFechar">Fechar</button></div>
    <video id="cam" playsinline autoplay muted></video>
    <canvas id="camCanvas" hidden></canvas>
    <div class="linha"><button class="btn" id="camCapturar">📸 Capturar página</button><span class="muted" id="camInfo">Abrindo câmera...</span></div>
  </div>`;
  $('#camFechar').onclick = fecharCamera;
  $('#camCapturar').onclick = async (e) => {
    const v = $('#cam');
    if (!v.videoWidth) return toast('A câmera ainda está abrindo...');
    const cv = $('#camCanvas');
    // Reduz para 2000 px: a Vercel limita o tamanho de cada requisição
    const k = Math.min(1, 2000 / Math.max(v.videoWidth, v.videoHeight));
    cv.width = Math.round(v.videoWidth * k); cv.height = Math.round(v.videoHeight * k);
    cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
    const imagem = cv.toDataURL('image/jpeg', 0.88);
    const slug = cur.slug;
    e.currentTarget.disabled = true;
    try {
      const r = await api('POST', `/materias/${slug}/provas/${provaId}/paginas`, { imagem });
      $('#camInfo').textContent = `Página salva: ${r.arquivo} ✔`;
      if (cur.tab === 'prova') await refreshTab();
    } catch (err) { toast('⚠️ ' + err.message); }
    finally { e.currentTarget.disabled = false; }
  };
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    $('#cam').srcObject = camStream;
    $('#camInfo').textContent = 'Posicione a página e capture.';
  } catch (e) {
    $('#camInfo').textContent = 'Câmera indisponível (' + e.message + '). Use "Enviar fotos".';
  }
}
function fecharCamera() {
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  const modal = $('#modal');
  if (modal) { modal.hidden = true; modal.innerHTML = ''; }
}

// --- mapas mentais ---
function arvoreHTML(no) {
  return `<li><span>${esc(no.texto)}</span>${no.filhos?.length ? `<ul>${no.filhos.map(arvoreHTML).join('')}</ul>` : ''}</li>`;
}
function tabMapas() {
  const { mapas } = cache;
  $('#conteudo').innerHTML = `
  <section class="card">
    <h2>Gerar mapa mental</h2>
    <div class="linha">
      <select id="mFonte">${opcoesFonte()}</select>
      <button class="btn" id="mGerar">🧠 Gerar mapa</button>
    </div>
    <p class="muted">Escolha "resumos marcados para a prova" para um mapa só com o que cai na prova.</p>
  </section>
  <section class="card">
    <h2>Mapas salvos</h2>
    ${mapas.length ? mapas.map((mp, i) => `
      <details class="mapa" ${i === 0 ? 'open' : ''}>
        <summary><strong>${esc(mp.titulo)}</strong> <small>${dataBR(mp.criadoEm.slice(0, 10))} · ${rotuloFonte(mp.fonte)}</small></summary>
        <ul class="arvore">${arvoreHTML(mp.arvore)}</ul>
      </details>`).join('') : '<p class="vazio">Nenhum mapa ainda.</p>'}
  </section>`;
  $('#mGerar').onclick = (e) => acao(e.currentTarget, '🧠 Criando mapa...', async () => {
    await api('POST', `/materias/${cur.slug}/mapas`, { fonte: $('#mFonte').value });
    toast('Mapa mental criado e salvo na pasta da matéria');
    await refreshTab();
  });
}

// --- perguntas para decorar ---
function tabPerguntas() {
  const { perguntas } = cache;
  $('#conteudo').innerHTML = `
  <section class="card">
    <h2>Gerar perguntas para decorar</h2>
    <div class="linha">
      <select id="pFonte">${opcoesFonte()}</select>
      <input type="number" id="pQtd" min="3" max="25" value="10" style="width:90px" aria-label="Quantidade">
      <button class="btn" id="pGerar">🃏 Gerar perguntas</button>
    </div>
  </section>
  <section class="card">
    <h2>Cartões de revisão <small>${perguntas.length} no total</small></h2>
    <div class="cartoes">${perguntas.length ? perguntas.map((p) => `
      <article class="cartao">
        <p class="pergunta"><strong>${esc(p.pergunta)}</strong></p>
        <details><summary>Ver resposta</summary><p>${esc(p.resposta)}</p></details>
        <div class="linha space">
          <span class="muted">✔ ${p.acertos} · ✖ ${p.erros}</span>
          <span class="linha">
            <button class="btn sec pequeno" data-acerto="${p.id}" data-ok="1">Sabia</button>
            <button class="btn sec pequeno" data-acerto="${p.id}" data-ok="0">Não sabia</button>
          </span>
        </div>
      </article>`).join('') : '<p class="vazio">Nenhuma pergunta ainda.</p>'}</div>
  </section>`;
  $('#pGerar').onclick = (e) => acao(e.currentTarget, '🃏 Gerando...', async () => {
    const novas = await api('POST', `/materias/${cur.slug}/perguntas`, { fonte: $('#pFonte').value, quantidade: Number($('#pQtd').value) });
    toast(`${novas.length} pergunta(s) criadas`);
    await refreshTab();
  });
  $$('[data-acerto]').forEach((b) => (b.onclick = async () => {
    await api('PUT', `/materias/${cur.slug}/perguntas/${b.dataset.acerto}`, { acertou: b.dataset.ok === '1' });
    await refreshTab();
  }));
}

// --- dúvidas por voz ---
function cardDuvida(d, aberta = false) {
  const yt = videoId(d.videoUrl);
  return `<article class="duvida">
    <details ${aberta ? 'open' : ''}>
      <summary><strong>${esc(d.pergunta)}</strong> <small>${dataBR(d.criadoEm.slice(0, 10))}</small></summary>
      <div class="resposta">${esc(d.resposta)}</div>
      <div class="linha">
        <button class="btn sec pequeno" data-ouvir="${d.id}">🔊 Ouvir</button>
        <a class="btn sec pequeno" target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=${encodeURIComponent(d.buscaYoutube || d.pergunta)}">▶ Buscar vídeo no YouTube</a>
      </div>
      ${yt ? `<div class="video"><iframe src="https://www.youtube.com/embed/${yt}" title="Vídeo que tira a dúvida" allowfullscreen loading="lazy"></iframe></div>` : ''}
      <form class="linha" data-video="${d.id}">
        <input name="url" type="url" placeholder="Cole o link do YouTube que tirou a dúvida" value="${esc(d.videoUrl || '')}" style="flex:1">
        <button class="btn sec pequeno">Salvar vídeo</button>
      </form>
    </details>
  </article>`;
}
function tabDuvidas() {
  const { duvidas } = cache;
  $('#conteudo').innerHTML = `
  <section class="card">
    <h2>Tirar dúvida com o Claude</h2>
    <p class="muted">Fale no microfone ou escreva. O Claude responde usando os resumos desta matéria e sugere um vídeo no YouTube.</p>
    <textarea id="dTexto" rows="4" placeholder="Ex.: Não entendi como calcular o delta na equação do 2º grau..."></textarea>
    <div class="linha">
      <button class="btn sec" id="dMic">🎤 Falar</button>
      <button class="btn" id="dEnviar">💬 Perguntar ao Claude</button>
    </div>
  </section>
  <section class="card">
    <h2>Dúvidas desta matéria</h2>
    ${duvidas.length ? duvidas.map((d, i) => cardDuvida(d, i === 0)).join('') : '<p class="vazio">Nenhuma dúvida ainda.</p>'}
  </section>`;

  $('#dMic').onclick = (e) => ditar(e.currentTarget, $('#dTexto'));
  $('#dEnviar').onclick = (e) => acao(e.currentTarget, '💬 Pensando...', async () => {
    await api('POST', `/materias/${cur.slug}/duvidas`, { pergunta: $('#dTexto').value });
    toast('Resposta pronta');
    await refreshTab();
  });
  $$('[data-ouvir]').forEach((b) => (b.onclick = () => {
    const d = cache.duvidas.find((x) => x.id === b.dataset.ouvir);
    if (d) falar(d.resposta);
  }));
  $$('[data-video]').forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const url = new FormData(f).get('url');
    try {
      await api('PUT', `/materias/${cur.slug}/duvidas/${f.dataset.video}`, { videoUrl: url || null });
      toast('Vídeo salvo na dúvida');
      await refreshTab();
    } catch (err) { toast('⚠️ ' + err.message); }
  }));
}

route();
