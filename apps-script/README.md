# Sistema-TS — PTA NR-35 + Formalização de Testes (V2.0)

Aplicação PWA (HTML/CSS/JS estático + Google Apps Script) para o GRUPO SRF.

## Estrutura

- `index.html` — shell, abas PTA NR-35 e Formalização de Testes
- `assets/app-core.js` — núcleo compartilhado (chave de acesso, cliente HTTP, portão)
- `assets/app-v1.8.js` — lógica PTA NR-35 (PDF jsPDF + autotable)
- `assets/formalizacao.js` — lógica Formalização de Testes
- `assets/app-shell.css` — design system compartilhado (tokens, layout, estados)
- `assets/styles-v1.8.css` — estilos PTA-only
- `assets/formalizacao.css` — estilos `.formalization-*`
- `apps-script/Code.gs` — PTA + roteador + auth (`requireAccessKey_`)
- `apps-script/formalizacao.gs` — handlers de formalização
- `sw.js` — Service Worker (precache, offline fallback)
- `manifest.webmanifest` — manifesto PWA

## Backend (Google Apps Script)

- **Endpoint:** `https://script.google.com/macros/s/AKfycbyFvLj8wq2gY0enpCiKPWewVpcj_LVWrt9w06Rz2wA582ZY0_GUWxr-gHDUMIQynbmv/exec`
- **Deployment:** release `@12` ("Formalizacao de Testes v2.0 – release")
- **Projeto:** clasp 3.3.0 em `apps-script/`
- **Propriedades do Script:**
  - `FORMALIZATION_ACCESS_KEY` = chave de acesso (min 8 chars, comparação constante-tempo)
  - `FORMALIZATION_MAIL_MODE` = vazio (envio real) ou `SIMULATED` (apenas testes)
  - `FORMALIZATION_FOLDER_ID` = pasta raiz privada no Drive
  - `FORMALIZATION_SS_ID` = planilha central

## Mapeamento commit ↔ deploy ↔ endpoint

| Commit | Branch | Deploy | Endpoint |
|--------|--------|--------|----------|
| `723c970` | main | pré-V2.0 | (legado) |
| `0a09f56` | feature/formalizacao-v2 | — | — |
| `107e401` | feature/formalizacao-v2 | — | — |
| `cc2a8c6` | main (merge) | @12 | URL acima |

## Autenticação

A chave de acesso **não está no código**. É digitada pelo responsável no portão `#accessGate` e armazenada em `sessionStorage` via `AppCore`. O servidor valida a cada requisição com `requireAccessKey_`.

## Formalização de Testes — fluxo

1. **Criar** formalização (rascunho local em IndexedDB).
2. **Anexar FDS** (PDF) por produto — hash SHA-256 calculado no cliente.
3. **Salvar rascunho** — sincroniza com Sheets via `FORMALIZATION_SAVE` (baseVersion para conflito).
4. **Revisar e-mail** — tela obrigatória `emailReview` (destinatário, assunto, corpo, anexos).
5. **Enviar** — idempotente (`idempotencyKey` + `contentHash`); status `processamento → enviado | pendente | confirmacao_pendente`.
6. **Registrar resposta** — importar `.eml`/PDF, escolher comunicação correta, `receivedAt` real ou "desconhecida".
7. **Exportar documentação** — ZIP com PDF do procedimento, FDS, respostas, `historico.json`, `INDICE.txt`, `LEIA-ME.txt`.

## Chave Groq

A chave Groq **não deve ser escrita no código, enviada ao GitHub ou adicionada ao JavaScript do navegador**. Configure em Propriedades do Script (`GROQ_API_KEY`, `GROQ_MODEL`).

## Responsável

Desenvolvido por **Jhonatan Cardoso Gonçalves**  
WhatsApp: https://wa.me/5548992159791