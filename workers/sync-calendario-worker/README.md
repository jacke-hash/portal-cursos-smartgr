# sync-calendario-worker

Versão em Cloudflare Worker do `scripts/sync-google-sheets.mjs`.

Substitui o cron do GitHub Actions (que atrasava ~40-55min em vez de 15min)
por um Cron Trigger real da Cloudflare, gratuito no plano Free.

## Onde colocar no repositório

Recomendado: `smartgr-cursos-portal/workers/sync-calendario-worker/`

(mesmo padrão de pasta que vocês já usam para `workers/shopify-webhook`)

```
smartgr-cursos-portal/
  workers/
    shopify-webhook/        → já existe
    sync-calendario-worker/ → esta pasta
      src/index.js
      wrangler.toml
      README.md
```

## Passo a passo de deploy (rodar UMA vez)

### 1. Entrar na pasta do worker

```powershell
cd C:\Users\mktsm\smartgr-cursos-portal\workers\sync-calendario-worker
```

### 2. Configurar o secret (a mesma service account já usada no GitHub Actions)

Copie o **conteúdo completo** do `firebase-service-account.json`
(o mesmo que está no secret `FIREBASE_SERVICE_ACCOUNT_JSON` do GitHub) e rode:

```powershell
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```

Ele vai pedir pra colar o valor no terminal — cole o JSON inteiro (uma linha só, ou
formatado, tanto faz) e aperta Enter.

> ⚠️ Confirme que essa service account tem permissão de **Editor** (ou pelo menos
> escrita) na planilha `1gsSMkeQceBYTRa9IKshvuNqa-WGImLNUcPKt2h3iSJg` — se ela já
> funciona no GitHub Actions hoje, já está compartilhada corretamente, não precisa
> mexer em nada no Google Sheets.

### 3. Deploy

```powershell
npx wrangler deploy
```

Isso já ativa o Cron Trigger automaticamente (`*/15 * * * *` — definido no
`wrangler.toml`). Não precisa fazer mais nada depois disso.

### 4. Testar disparo manual (opcional, mas recomendado na primeira vez)

Depois do deploy, o Wrangler mostra uma URL tipo:

```
https://sync-calendario-worker.<seu-subdominio>.workers.dev
```

Abra no navegador:

```
https://sync-calendario-worker.<seu-subdominio>.workers.dev/run
```

Isso dispara a sincronização na hora e devolve um JSON com o resultado:

```json
{
  "ok": true,
  "eventos": 84,
  "atualizacoes": 79,
  "semCorrespondencia": 5,
  "ms": 2143
}
```

### 5. Acompanhar logs em tempo real

```powershell
npx wrangler tail sync-calendario-worker
```

Deixa esse comando rodando e recarrega a URL `/run` (ou espera o próximo ciclo
de 15min) pra ver o log completo de matching, igual ao script `.mjs` original.

## Depois de ativado

Você **não precisa mais rodar nada manualmente**. O Worker roda sozinho a cada
15 minutos, para sempre, sem depender do GitHub Actions.

Se quiser desligar o `sync-sheets.yml` do GitHub Actions pra não ficar rodando
duplicado (gastando minutos de Actions à toa), pode desabilitar o workflow em:
GitHub → Actions → Sync Firestore → Google Sheets → "..." → Disable workflow.
(Rodar os dois em paralelo não quebra nada — só é redundante.)

## Diferenças em relação ao script original

- **Sem `firebase-admin` / `googleapis`**: Cloudflare Workers não roda essas libs
  (dependem do runtime Node.js completo). A autenticação e as chamadas à API do
  Firestore/Sheets são feitas via REST direto, usando Web Crypto API para assinar
  o JWT da service account.
- **Sem paginação profunda no Firestore**: usa *collection group queries*
  (`eventos` e `inscritos` em qualquer curso/evento) em vez do loop aninhado
  `for curso → for evento → for inscrito` do script original. Resultado final é
  o mesmo, só a forma de buscar é mais direta. Para o volume atual do SmartGR
  (centenas de inscritos, não dezenas de milhares), um único batch cobre tudo —
  se um dia o volume crescer muito, avise que adicionamos paginação por cursor.
- **`cursoNome` no log** vem do `cursoId` (o `collection group query` não traz
  automaticamente o nome do documento pai). Não afeta o matching nem a escrita
  na planilha — só o texto do log fica um pouco menos "bonito".
