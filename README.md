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

Requer Node.js 18 ou superior. Não há dependências para instalar.

```bash
cd estudos-dashboard
ANTHROPIC_API_KEY=sua_chave node server.js
```

Abra http://localhost:3000 no navegador.

Variáveis opcionais:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (vazio) | Necessária para mapas, perguntas, dúvidas e leitura de prova |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | Modelo usado. Para respostas mais elaboradas, use `claude-sonnet-5-5` |
| `PORT` | `3000` | Porta do servidor |
| `DATA_DIR` | `./data` | Onde ficam as pastas das matérias |

## Observações

- **Câmera e microfone** exigem `localhost` ou HTTPS. Para usar pelo celular na mesma rede,
  sirva por HTTPS (por exemplo, com um túnel) ou use "Enviar fotos" e o ditado no Chrome.
- **Voz** funciona no Chrome e no Edge (reconhecimento de voz do navegador).
- O servidor não tem login: rode-o só na sua máquina ou em rede confiável.
- Para fazer backup, copie a pasta `data/`.
