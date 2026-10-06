// Reprocessa um pedido específico da Shopify e atualiza o inscrito correspondente
// no Firestore, usando current_quantity (quantidade pós-edição/reembolso).
// A lista de cursos vem da coleção `cursos` do Firestore (shared/cursos.mjs).
// Sem --apply é SIMULAÇÃO (mostra o que seria gravado); grava de fato só com --apply.
// Uso: node scripts/reprocess-order.mjs SPFY23673 [--apply]

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { loadCursos } from '../shared/cursos.mjs';
import { APPLY, avisoSimulacao } from '../shared/cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const orderName = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!orderName) {
  console.error('Uso: node scripts/reprocess-order.mjs <NomeDoPedido, ex: SPFY23673> [--apply]');
  process.exit(1);
}

const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'smart-gr-pro.myshopify.com';
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_BASE = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;

const sa = JSON.parse(readFileSync(join(__dirname, '..', 'service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

function parseVariantTitle(title) {
  if (!title || typeof title !== 'string') return null;
  const idx = title.indexOf(' - ');
  if (idx === -1) return { date: null, local: title.trim() };
  const datePart = title.slice(0, idx).trim();
  const local = title.slice(idx + 3).trim();
  const segments = datePart.split('/');
  if (segments.length !== 3) return { date: null, local: title.trim() };
  const [day, month, year] = segments;
  const date = new Date(`${year}-${month}-${day}T12:00:00.000Z`);
  if (isNaN(date.getTime())) return { date: null, local: title.trim() };
  return { date, local };
}

function calcFinancials(item, order) {
  const quantidade    = item.current_quantity ?? item.quantity ?? 1;
  const precoCatalogo = parseFloat(item.price) || 0;
  const subtotal      = precoCatalogo * quantidade;

  let descontoAplicado =
    item.total_discount !== undefined
      ? (parseFloat(item.total_discount) || 0)
      : (item.discount_allocations || []).reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);

  if (descontoAplicado === 0) {
    const orderDiscount = parseFloat(order.current_total_discounts) || 0;
    if (orderDiscount > 0) {
      const orderSubtotal = (order.line_items || []).reduce(
        (s, li) => s + (parseFloat(li.price) || 0) * (li.current_quantity ?? li.quantity ?? 1), 0
      );
      const share = orderSubtotal > 0 ? subtotal / orderSubtotal : 1;
      descontoAplicado = Math.min(orderDiscount * share, subtotal);
    }
  }

  const valorFinalPago    = Math.max(0, subtotal - descontoAplicado);
  const valorUnitarioPago = quantidade > 0 ? valorFinalPago / quantidade : 0;
  return { quantidade, precoCatalogo, descontoAplicado, valorFinalPago, valorUnitarioPago };
}

async function recalcEvento(productId, variantId) {
  const eventoRef = db.collection('cursos').doc(String(productId)).collection('eventos').doc(variantId);
  const inscritosSnap = await eventoRef.collection('inscritos').get();
  const inscritos = inscritosSnap.docs.map(d => d.data());
  const INACTIVE = new Set(['Cancelado', 'Reembolsado', 'Parcialmente Reembolsado', 'Expirado', 'Pendente', 'Autorizado', 'Anulado']);
  const isAtivo = i => i.financialStatus ? i.financialStatus === 'paid' : !INACTIVE.has(i.status);
  const ativos = inscritos.filter(isAtivo);
  const confirmados = ativos.filter(i => i.status === 'Confirmado' || i.status === 'Presente').length;
  await eventoRef.set({ totalInscritos: ativos.length, confirmados, updatedAt: Timestamp.now() }, { merge: true });
}

async function recalcCurso(productId) {
  const cursoRef = db.collection('cursos').doc(String(productId));
  const eventosSnap = await cursoRef.collection('eventos').get();
  const totalInscritos = eventosSnap.docs.reduce((s, d) => s + (d.data().totalInscritos || 0), 0);
  await cursoRef.set({ totalInscritos, totalEventos: eventosSnap.size, totalEventosAtivos: eventosSnap.docs.filter(d => d.data().ativo === true).length, updatedAt: Timestamp.now() }, { merge: true });
}

async function main() {
  const cursos = await loadCursos(db);

  console.log(`Buscando pedido ${orderName} na Shopify...`);
  const resp = await fetch(
    `${SHOPIFY_BASE}/orders.json?name=${encodeURIComponent(orderName)}&status=any`,
    { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
  );
  if (!resp.ok) throw new Error(`Shopify API ${resp.status}: ${await resp.text()}`);
  const { orders } = await resp.json();
  const order = orders?.[0];
  if (!order) {
    console.error(`Pedido ${orderName} não encontrado na Shopify.`);
    process.exit(1);
  }
  console.log(`Pedido encontrado: id=${order.id} financial_status=${order.financial_status}`);

  const affected = [];
  for (const item of order.line_items || []) {
    const productId = Number(item.product_id);
    if (!cursos.has(productId) || !item.variant_id || !item.variant_title) continue;

    const parsed = parseVariantTitle(item.variant_title);
    if (!parsed) continue;

    const variantId  = String(item.variant_id);
    const inscritoId = `${order.id}-${variantId}`;
    const path = `cursos/${productId}/eventos/${variantId}/inscritos/${inscritoId}`;
    const ref  = db.doc(path);
    const snap = await ref.get();

    if (!snap.exists) {
      console.log(`  Inscrito não encontrado no Firestore: ${path} — pulando (rode a sincronização completa se precisar criar)`);
      continue;
    }

    const fin = calcFinancials(item, order);
    console.log(`  ${APPLY ? '' : '(simulação) '}${path}: quantidade ${snap.data().quantidade} → ${fin.quantidade} | valorFinalPago ${snap.data().valorFinalPago} → ${fin.valorFinalPago}`);

    if (APPLY) await ref.set({ ...fin, valor: fin.valorFinalPago, updatedAt: Timestamp.now() }, { merge: true });
    affected.push({ productId, variantId });
  }

  const seen = new Set();
  for (const { productId, variantId } of affected) {
    const key = `${productId}:${variantId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (APPLY) await recalcEvento(productId, variantId);
    if (APPLY) await recalcCurso(productId);
  }

  console.log(`\n${affected.length} inscrição(ões) ${APPLY ? 'reprocessada(s)' : 'seriam reprocessada(s)'}.`);
  avisoSimulacao();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
