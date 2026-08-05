/**
 * ================================================================
 * scripts/reconciliacao-pedidos.mjs
 * SmartGR — Reconciliação Shopify → Firestore (Portal de Cursos)
 * ================================================================
 *
 * Detecta pedidos pagos na Shopify (últimas N horas) que não têm
 * inscrito correspondente no Firestore, e alerta por e-mail (Resend).
 *
 * Somente leitura: nunca grava/altera nada no Firestore.
 *
 * Execução manual:
 *   node scripts/reconciliacao-pedidos.mjs
 *   WINDOW_HOURS=168 node scripts/reconciliacao-pedidos.mjs   (janela de teste, 7 dias)
 *
 * Sem RESEND_API_KEY definido, o script detecta e imprime o e-mail
 * que seria enviado, mas não envia nada — seguro para rodar local.
 * ================================================================
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------
// CONFIGURAÇÃO
// ----------------------------------------------------------------

const WINDOW_HOURS = Number(process.env.WINDOW_HOURS) || 48;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'smart-gr-pro.myshopify.com';
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_BASE = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || 'Portal Cursos SmartGR <alertas@smartgr.com.br>';
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || 'jacke@smartgr.com.br';

if (!SHOPIFY_TOKEN) {
  console.error('SHOPIFY_ACCESS_TOKEN não encontrado no ambiente');
  process.exit(1);
}

// ----------------------------------------------------------------
// KNOWN_COURSES / VALID_PRODUCT_IDS — lidos direto do worker,
// nunca hardcodados aqui, para não divergir da fonte real.
// ----------------------------------------------------------------

function lerCatalogoDoWorker() {
  const workerPath = resolve(__dirname, '../workers/shopify-webhook/src/index.js');
  const src = readFileSync(workerPath, 'utf8');
  const bloco = src.match(/const KNOWN_COURSES = new Map\(\[([\s\S]*?)\]\);/);
  if (!bloco) {
    throw new Error(
      `Não foi possível extrair KNOWN_COURSES de ${workerPath}. ` +
      `O formato do array pode ter mudado — ajuste o regex em lerCatalogoDoWorker().`
    );
  }
  const entradas = [...bloco[1].matchAll(/\[\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\s*\]/g)]
    .map(m => [Number(m[1]), m[2].replace(/\\'/g, "'")]);
  if (entradas.length === 0) {
    throw new Error('KNOWN_COURSES foi encontrado mas nenhuma entrada foi parseada — regex desatualizado.');
  }
  return new Map(entradas);
}

const KNOWN_COURSES = lerCatalogoDoWorker();
const VALID_PRODUCT_IDS = new Set(KNOWN_COURSES.keys());

console.log(`Catálogo lido do worker: ${KNOWN_COURSES.size} produto(s) monitorado(s)`);

// ----------------------------------------------------------------
// FIREBASE — mesmo padrão de credenciais do sync-google-sheets.mjs
// ----------------------------------------------------------------

function lerServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const localPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || resolve(__dirname, '../service-account.json');
  return JSON.parse(readFileSync(localPath, 'utf8'));
}

initializeApp({ credential: cert(lerServiceAccount()) });
const db = getFirestore();

// ----------------------------------------------------------------
// SHOPIFY — busca de pedidos pagos, não cancelados, na janela de tempo
// ----------------------------------------------------------------

async function shopifyGet(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let resp;
  try {
    resp = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (resp.status === 429) {
    const retry = parseFloat(resp.headers.get('Retry-After') || '2');
    await new Promise(r => setTimeout(r, retry * 1000));
    return shopifyGet(url);
  }
  if (!resp.ok) throw new Error(`Shopify API ${resp.status}: ${await resp.text()}`);
  return { data: await resp.json(), headers: resp.headers };
}

async function buscarPedidosPagosRecentes(sinceIso) {
  const pedidos = [];
  let url = `${SHOPIFY_BASE}/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(sinceIso)}&limit=250&fields=id,name,line_items,created_at,cancelled_at,cancel_reason`;
  let pagina = 0;
  while (url) {
    pagina++;
    const { data, headers } = await shopifyGet(url);
    pedidos.push(...(data.orders || []));
    const link = headers.get('Link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
    console.log(`  página ${pagina}: acumulado ${pedidos.length} pedido(s)`);
  }
  return pedidos;
}

// ----------------------------------------------------------------
// RECONCILIAÇÃO
// ----------------------------------------------------------------

async function reconciliar() {
  const desde = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);
  console.log(`\n=== Reconciliação de pedidos — janela: últimas ${WINDOW_HOURS}h (desde ${desde.toISOString()}) ===\n`);

  console.log('Buscando pedidos pagos na Shopify...');
  const pedidos = await buscarPedidosPagosRecentes(desde.toISOString());
  console.log(`Total de pedidos pagos na janela: ${pedidos.length}`);

  const pedidosAtivos = pedidos.filter(o => o.cancel_reason === null || o.cancel_reason === undefined);
  console.log(`Pedidos não cancelados: ${pedidosAtivos.length} (${pedidos.length - pedidosAtivos.length} cancelado(s) excluído(s) — comportamento esperado)`);

  const relevantes = [];
  for (const order of pedidosAtivos) {
    for (const item of order.line_items || []) {
      const productId = Number(item.product_id);
      if (!VALID_PRODUCT_IDS.has(productId)) continue;
      if (!item.variant_id) continue; // sem variant_id não há path determinístico a checar
      relevantes.push({
        orderId: order.id,
        orderName: order.name,
        productId,
        variantId: String(item.variant_id),
        variantTitle: item.variant_title,
        price: item.price,
        quantity: item.quantity,
        createdAt: order.created_at,
      });
    }
  }
  console.log(`Line items relevantes (produtos monitorados): ${relevantes.length}`);

  const ausentes = [];
  for (const item of relevantes) {
    const inscritoId = `${item.orderId}-${item.variantId}`;
    const path = `cursos/${item.productId}/eventos/${item.variantId}/inscritos/${inscritoId}`;
    const snap = await db.doc(path).get();
    if (!snap.exists) ausentes.push({ ...item, path });
  }

  console.log(`\nPedidos ausentes no Firestore: ${ausentes.length}`);
  for (const a of ausentes) {
    console.log(`  ${a.orderName} | produto=${KNOWN_COURSES.get(a.productId) || a.productId} | variant_id=${a.variantId} | title="${a.variantTitle}" | valor=${a.price} | ${a.createdAt}`);
  }

  return ausentes;
}

// ----------------------------------------------------------------
// E-MAIL (Resend)
// ----------------------------------------------------------------

function montarEmailHtml(ausentes) {
  const linhas = ausentes.map(a => {
    const valor = (parseFloat(a.price) || 0) * (a.quantity || 1);
    const nomeProduto = KNOWN_COURSES.get(a.productId) || String(a.productId);
    const linkShopify = `https://admin.shopify.com/store/smart-gr-pro/orders/${a.orderId}`;
    return `
      <tr>
        <td style="padding:6px 10px;border:1px solid #ddd;"><a href="${linkShopify}">${a.orderName}</a></td>
        <td style="padding:6px 10px;border:1px solid #ddd;">${nomeProduto}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;">${a.variantId}${a.variantTitle ? ` (${a.variantTitle})` : ' (sem título)'}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;">R$ ${valor.toFixed(2)}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;">${new Date(a.createdAt).toLocaleString('pt-BR')}</td>
      </tr>`;
  }).join('');

  return `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">
      <h2>⚠️ Portal Cursos: ${ausentes.length} pedido(s) pago(s) sem inscrito correspondente</h2>
      <p>Os pedidos abaixo estão marcados como pagos e não cancelados na Shopify, mas não têm
      documento de inscrito correspondente no Firestore. Verifique manualmente antes de decidir
      como tratar cada caso (não são gravados automaticamente).</p>
      <table style="border-collapse:collapse;width:100%;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Pedido</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Produto</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Variant ID</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Valor</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Data do pedido</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`;
}

function montarEmailTexto(ausentes) {
  const linhas = ausentes.map(a => {
    const valor = (parseFloat(a.price) || 0) * (a.quantity || 1);
    const nomeProduto = KNOWN_COURSES.get(a.productId) || String(a.productId);
    return `- ${a.orderName} | ${nomeProduto} | variant_id=${a.variantId} | R$ ${valor.toFixed(2)} | ${a.createdAt} | https://admin.shopify.com/store/smart-gr-pro/orders/${a.orderId}`;
  }).join('\n');
  return `Portal Cursos: ${ausentes.length} pedido(s) pago(s) sem inscrito correspondente\n\n${linhas}\n`;
}

async function enviarAlerta(ausentes) {
  const assunto = `⚠️ Portal Cursos: ${ausentes.length} pedido(s) pago(s) sem inscrito correspondente`;
  const html = montarEmailHtml(ausentes);
  const text = montarEmailTexto(ausentes);

  if (!RESEND_API_KEY) {
    console.log('\n=== RESEND_API_KEY não definido — e-mail NÃO enviado. Conteúdo que seria enviado: ===');
    console.log(`Para: ${ALERT_EMAIL_TO}`);
    console.log(`Assunto: ${assunto}`);
    console.log(text);
    return;
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: ALERT_EMAIL_FROM,
      to: [ALERT_EMAIL_TO],
      subject: assunto,
      html,
      text,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Falha ao enviar e-mail via Resend: ${resp.status} ${await resp.text()}`);
  }
  console.log(`\n✓ E-mail de alerta enviado para ${ALERT_EMAIL_TO}`);
}

// ----------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------

async function main() {
  const ausentes = await reconciliar();

  if (ausentes.length === 0) {
    console.log('\nReconciliação OK — nenhum pedido ausente.');
    return;
  }

  await enviarAlerta(ausentes);
}

main().catch(err => {
  console.error('\nErro fatal na reconciliação:', err.message || err);
  process.exit(1);
});
