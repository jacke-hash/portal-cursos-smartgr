/**
 * backfill-pedidos-shopify.mjs
 *
 * Repõe no Firestore os pedidos PAGOS da Shopify que ficaram sem inscrito (webhook
 * perdido — ex.: cota do Firestore estourada, worker fora do ar). Busca os pedidos
 * completos na Shopify e grava o inscrito exatamente como o worker faria
 * (workers/shopify-webhook/src/index.js processOrder). Nunca altera inscrito que já existe.
 *
 * Depois de gravar, rode `node scripts/recalc-agregados.mjs --apply` para acertar
 * totalInscritos/confirmados dos eventos e cursos.
 *
 * Uso:
 *   node scripts/backfill-pedidos-shopify.mjs                       # simulação (janela 1500h)
 *   WINDOW_HOURS=2000 node scripts/backfill-pedidos-shopify.mjs --apply
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { loadCursos } from '../shared/cursos.mjs';
import { DATE_CUTOFF, parseVariantTitle, hasOnlineTag, isVarianteSemTitulo, buildEventoOnlineFields, TITULO_EVENTO_ONLINE } from '../shared/eventos.mjs';
import { APPLY, avisoSimulacao } from '../shared/cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const BASE = 'https://smart-gr-pro.myshopify.com/admin/api/2024-01';
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS) || 1500;
if (!TOKEN) { console.error('SHOPIFY_ACCESS_TOKEN ausente'); process.exit(1); }

const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || resolve(__dirname, '../service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

async function shopifyGet(url) {
  const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
  if (resp.status === 429) { await new Promise(r => setTimeout(r, 2000)); return shopifyGet(url); }
  if (!resp.ok) throw new Error(`Shopify ${resp.status}: ${await resp.text()}`);
  return { data: await resp.json(), headers: resp.headers };
}

const onlineCache = new Map();
async function produtoOnline(productId) {
  if (!onlineCache.has(productId)) {
    const { data } = await shopifyGet(`${BASE}/products/${productId}.json?fields=id,tags`);
    onlineCache.set(productId, hasOnlineTag(data.product?.tags));
  }
  return onlineCache.get(productId);
}

// ── Espelhado de workers/shopify-webhook/src/index.js (manter em paridade) ─────
function calcFinancials(item, order) {
  const quantidade    = item.current_quantity ?? item.quantity ?? 1;
  const precoCatalogo = parseFloat(item.price) || 0;
  const subtotal      = precoCatalogo * quantidade;
  let descontoAplicado = item.total_discount !== undefined
    ? (parseFloat(item.total_discount) || 0)
    : (item.discount_allocations || []).reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
  if (descontoAplicado === 0) {
    const orderDiscount = parseFloat(order.current_total_discounts) || 0;
    if (orderDiscount > 0) {
      const orderSubtotal = (order.line_items || []).reduce((s, li) => s + (parseFloat(li.price) || 0) * (li.current_quantity ?? li.quantity ?? 1), 0);
      const share = orderSubtotal > 0 ? subtotal / orderSubtotal : 1;
      descontoAplicado = Math.min(orderDiscount * share, subtotal);
    }
  }
  const valorFinalPago    = Math.max(0, subtotal - descontoAplicado);
  const valorUnitarioPago = quantidade > 0 ? valorFinalPago / quantidade : 0;
  return { quantidade, precoCatalogo, descontoAplicado, valorFinalPago, valorUnitarioPago };
}

function extractFormacaoInfo(attributes) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const valor = (key) => attributes.find((a) => norm(a.name) === key)?.value?.trim() || '';
  const perfil = norm(valor('perfil_cliente'));
  if (perfil === 'profissional') return { perfil: 'profissional', formacao: valor('profissao_cliente'), especialidade: valor('especialidade_cliente') };
  if (perfil === 'estudante') { const area = valor('area_estudo_cliente'); return { perfil: 'estudante', formacao: area === '-' ? '' : area, especialidade: '' }; }
  if (['consumidor', 'consumidor_final', 'consumidor final'].includes(perfil)) return { perfil: 'consumidor', formacao: '', especialidade: '' };
  const legado = attributes.find(({ name }) =>
    ['formacao', 'formação', 'profissao', 'profissão', 'profissao_cliente', 'area de atuacao', 'área de atuação', 'ocupacao', 'ocupação'].includes(norm(name))
  )?.value || '';
  return { perfil: '', formacao: legado, especialidade: '' };
}

function extractCustomer(order) {
  const attributes = order.note_attributes || [];
  const { perfil, formacao, especialidade } = extractFormacaoInfo(attributes);
  return {
    cliente: [order.billing_address?.first_name || order.customer?.first_name || '', order.billing_address?.last_name || order.customer?.last_name || ''].join(' ').trim(),
    email: order.email || '',
    telefone: order.billing_address?.phone || order.customer?.phone || order.shipping_address?.phone || '',
    cidade: order.billing_address?.city || order.shipping_address?.city || '',
    estado: order.billing_address?.province || order.shipping_address?.province || '',
    empresa: order.billing_address?.company || order.customer?.default_address?.company || '',
    vendedor: attributes.find(a => a.name === 'Affiliate')?.value || '',
    perfil, formacao, especialidade,
  };
}

async function main() {
  const cursos = await loadCursos(db);
  const desde = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString();
  console.log(`Modo: ${APPLY ? 'APLICAR' : 'SIMULAÇÃO'} | pedidos pagos desde ${desde}`);

  const pedidos = [];
  let url = `${BASE}/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(desde)}&limit=250`;
  while (url) {
    const { data, headers } = await shopifyGet(url);
    pedidos.push(...(data.orders || []));
    url = (headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  }
  console.log(`Pedidos pagos lidos: ${pedidos.length}`);

  let criados = 0, existentes = 0;
  const eventos = new Set();
  for (const order of pedidos) {
    if (order.cancel_reason || order.cancelled_at) continue;
    for (const item of order.line_items || []) {
      const productId = Number(item.product_id);
      if (!cursos.has(productId) || !item.variant_id) continue;
      // Curso online sem turmas: variante única vira o evento fixo "Online"
      if (isVarianteSemTitulo(item.variant_title)) {
        if (!(await produtoOnline(productId))) continue;
        item.variant_title = TITULO_EVENTO_ONLINE;
        const evRef = db.doc(`cursos/${productId}/eventos/${item.variant_id}`);
        if (APPLY && !(await evRef.get()).exists) {
          await evRef.set(
            { ...buildEventoOnlineFields({ id: item.variant_id }), totalInscritos: 0, confirmados: 0, updatedAt: Timestamp.now() });
        }
      }
      const parsed = parseVariantTitle(item.variant_title);
      if (!parsed || (parsed.date !== null && parsed.date < DATE_CUTOFF)) continue;

      const variantId = String(item.variant_id);
      const ref = db.doc(`cursos/${productId}/eventos/${variantId}/inscritos/${order.id}-${variantId}`);
      if ((await ref.get()).exists) { existentes++; continue; }

      const fin = calcFinancials(item, order);
      const cust = extractCustomer(order);
      const cpf = order.note_attributes?.find(a => a.name === 'cpf_cliente')?.value || '';
      const now = Timestamp.now();
      console.log(`  ${APPLY ? '+ gravando' : '(simulação) gravaria'}: ${order.name} | ${item.variant_title} | qtd ${fin.quantidade} | ${cust.cliente}`);
      if (APPLY) {
        await ref.set({
          pedido: order.name, shopifyId: String(order.id), productId: String(productId), variantId,
          variante: item.variant_title, ...fin, valor: fin.valorFinalPago,
          dataCompra: Timestamp.fromDate(new Date(order.created_at)),
          ...cust, cpf, financialStatus: 'paid',
          status: 'Não Confirmado', financialStatusUpdatedAt: now,
          observacao: '', impresso: false, impressoEm: null, impressoPor: null,
          createdAt: now, updatedAt: now,
        });
      }
      criados++;
      eventos.add(`${productId}/${variantId}`);
    }
  }
  console.log(`\nAusentes ${APPLY ? 'gravados' : 'a gravar'}: ${criados} | já existiam: ${existentes} | eventos afetados: ${eventos.size}`);
  if (criados) console.log('Próximo passo: node scripts/recalc-agregados.mjs --apply');
  avisoSimulacao();
}

main().catch(e => { console.error(e); process.exit(1); });
