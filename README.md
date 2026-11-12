# Painel de Estudos

Painel local para organizar os estudos do 8º ano ao 3º ano do Ensino Médio.
Cada matéria vira uma pasta no disco, com arquivos legíveis fora do app.

## O que tem

- **Cadastro de matérias** por série (8º ano, 9º ano, 1º, 2º e 3º EM), com sugestões prontas.
- **Resumo diário** por matéria. Cada dia vira um arquivo `resumos/AAAA-MM-DD.md`.
- **Cai na prova**: marque quais resumos entram na prova.
- **Prova & scanner**: crie a prova, escaneie páginas com a câmera ou envie fotos.
  As páginas ficam em `provas/<data>-<nome>/pagina-01.jpg`, etc.
- **Ler com Claude**: transcreve as páginas da prova (texto em `texto.md`).
- **Mapas mentais** gerados pelo Claude a partir dos resumos (todos, só os da prova, ou a prova lida).
- **Perguntas para decorar** (cartões de pergunta e resposta) com contador de acertos.
- **Dúvidas por voz**: fale no microfone (pt-BR), o Claude responde com base nos seus resumos,
  sugere uma busca no YouTube e você pode salvar o link do vídeo que tirou a dúvida.

## Estrutura de dados

```
data/materias/8ano-matematica/
  materia.json
  resumos/2026-11-12.md        # resumo do dia (com "na_prova: true/false")
  provas/2026-11-10-prova-1/
    prova.json
    pagina-01.jpg
    texto.md                   # transcrição feita pelo Claude
  mapas/<id>.json
  perguntas.json
  duvidas/<id>.json
```

## Como rodar

Requer Node.js 18 ou superior.

```bash
cd estudos-dashboard
npm install
ANTHROPIC_API_KEY=sua_chave DATABASE_URL=postgres://usuario:senha@host:5432/banco node server.js
```

Abra http://localhost:3000 no navegador.

Variáveis opcionais:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (vazio) | Necessária para mapas, perguntas, dúvidas e leitura de prova |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | Modelo usado. Para respostas mais elaboradas, use `claude-sonnet-5-5` |
| `PORT` | `3000` | Porta do servidor |
| `DATA_DIR` | `./data` | Onde ficam as pastas das matérias |
| `DATABASE_URL` | (vazio) | Conexão Postgres. Quando definida, cada gravação é copiada para o banco |
| `DATABASE_SSL` | (vazio) | Use `true` se o banco exigir SSL (como o Supabase) |
| `SESSION_SECRET` | (aleatório) | Segredo que assina os cookies de sessão. Obrigatória na Vercel |

## Contas de acesso

O painel pede email e senha. Não há cadastro público: as contas são criadas pelo terminal.

```bash
node criar-usuario.js seu@email.com "sua senha com 8+ caracteres"
```

- Para criar a conta no banco de produção, rode o comando com `DATABASE_URL` (e `DATABASE_SSL`) definidas. Sem `DATABASE_URL`, a conta vai para `data/usuarios.json`.
- Senhas são guardadas com scrypt. Depois de 5 erros seguidos para um email, o login fica bloqueado por 15 minutos.
- Sessão dura 30 dias. Não há "esqueci minha senha": quem perder a senha recria a conta com outro email, ou atualiza `senhaHash` no banco.

## Observações

- **Câmera e microfone** exigem `localhost` ou HTTPS. Para usar pelo celular na mesma rede,
  sirva por HTTPS (por exemplo, com um túnel) ou use "Enviar fotos" e o ditado no Chrome.
- **Voz** funciona no Chrome e no Edge (reconhecimento de voz do navegador).
- Todas as rotas de dados exigem login. Mesmo assim, prefira rodar na sua máquina ou em rede confiável.
- **Banco:** com `DATABASE_URL`, o Postgres é a fonte definitiva. Cada gravação é copiada para o banco (inclusive as fotos das provas, na tabela `paginas`), e antes de cada requisição os arquivos são reconstruídos a partir dele. Assim o app também funciona na Vercel, onde o disco é temporário. Se a gravação no banco falhar, a tela mostra o erro.
- **Vercel:** conecte o repositório, e nas variáveis do projeto defina `SESSION_SECRET`, `DATABASE_URL`, `DATABASE_SSL` (se necessário) e `ANTHROPIC_API_KEY`. Sem `SESSION_SECRET`, o app responde 503. Depois do deploy, crie a conta com `DATABASE_URL` de produção apontando para o banco.
- Para fazer backup, copie a pasta `data/`.
