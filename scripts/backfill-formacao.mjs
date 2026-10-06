// Backfill/recálculo do campo `formacao` (e separação profissional/estudante/
// consumidor final) para inscritos já existentes, em todos os cursos, para
// pedidos criados dentro de uma janela de datas.
// Busca os pedidos da Shopify em lote (por created_at) em vez de 1 chamada por
// inscrito, depois casa por shopifyId e faz patch só onde o valor mudou.
//
// A lista de cursos vem da coleção `cursos` do Firestore (shared/cursos.mjs).
// Sem --apply é SIMULAÇÃO (lista o que seria gravado); grava de fato só com --apply.
//
// Uso: node scripts/backfill-formacao.mjs [--from=2026-08-01] [--to=2026-09-24] [--apply]
// Sem argumentos: de 2026-08-01 até hoje.

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { loadCursos } from '../shared/cursos.mjs';
import { APPLY, avisoSimulacao } from '../shared/cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const argFrom = process.argv.find(a => a.startsWith('--from='))?.split('=')[1];
const argTo   = process.argv.find(a => a.startsWith('--to='))?.split('=')[1];
const FROM = argFrom ? new Date(`${argFrom}T00:00:00.000Z`) : new Date('2026-08-01T00:00:00.000Z');
const TO   = argTo   ? new Date(`${argTo}T23:59:59.999Z`)   : new Date();

const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'smart-gr-pro.myshopify.com';
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_BASE = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;

const sa = JSON.parse(readFileSync(join(__dirname, '..', 'service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': SHOPIFY_TOKEN };
}

async function fetchAllPages(firstUrl) {
  const items = [];
  let url = firstUrl;
  while (url) {
    console.log(`  → GET ${url}`);
    const resp = await fetch(url, { headers: shopifyHeaders() });
    if (!resp.ok) throw new Error(`Shopify API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const page = data.orders || [];
    items.push(...page);
    console.log(`    ${page.length} pedido(s) nesta página | total acumulado: ${items.length}`);
    const link = resp.headers.get('Link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    url = match ? match[1] : null;
  }
  return items;
}

// Deriva perfil (profissional/estudante/consumidor) e formação a partir do
// checkout: profissional usa a profissão declarada, estudante usa a área de
// estudo declarada — nunca um rótulo fixo. Pedidos antigos sem perfil_cliente
// caem no fallback pelos nomes legados, sem perfil definido.
function extractFormacaoInfo(attributes) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const valor = (key) => attributes.find((a) => norm(a.name) === key)?.value?.trim() || '';
  const perfil = norm(valor('perfil_cliente'));

  if (perfil === 'profissional') {
    return { perfil: 'profissional', formacao: valor('profissao_cliente') };
  }
  if (perfil === 'estudante') {
    const area = valor('area_estudo_cliente');
    return { perfil: 'estudante', formacao: area === '-' ? '' : area };
  }
  if (perfil === 'consumidor' || perfil === 'consumidor_final' || perfil === 'consumidor final') {
    return { perfil: 'consumidor', formacao: '' };
  }

  const legado = attributes.find(({ name }) =>
    ['formacao', 'formação', 'profissao', 'profissão', 'profissao_cliente', 'area de atuacao', 'área de atuação', 'ocupacao', 'ocupação']
      .includes(norm(name))
  )?.value || '';
  return { perfil: '', formacao: legado };
}

async function main() {
  const cursos = await loadCursos(db);
  console.log(`Janela: ${FROM.toISOString()} → ${TO.toISOString()}`);
  console.log('\nBuscando pedidos da Shopify no período (status=any)...');
  const firstUrl = `${SHOPIFY_BASE}/orders.json?status=any&limit=250&created_at_min=${FROM.toISOString()}&created_at_max=${TO.toISOString()}&fields=id,note_attributes`;
  const orders = await fetchAllPages(firstUrl);
  console.log(`Total de pedidos no período: ${orders.length}`);

  const infoById = new Map();
  for (const order of orders) {
    infoById.set(String(order.id), extractFormacaoInfo(order.note_attributes || []));
  }

  let totalInscritos = 0, atualizados = 0, semPedidoNoPeriodo = 0, semMudanca = 0;

  for (const productId of cursos.keys()) {
    const eventosSnap = await db.collection('cursos').doc(String(productId)).collection('eventos').get();
    for (const eventoDoc of eventosSnap.docs) {
      const inscritosSnap = await eventoDoc.ref.collection('inscritos').get();
      for (const doc of inscritosSnap.docs) {
        totalInscritos++;
        const data = doc.data();
        if (!infoById.has(data.shopifyId)) { semPedidoNoPeriodo++; continue; }

        const { perfil: novoPerfil, formacao: novaFormacao } = infoById.get(data.shopifyId);
        if (novaFormacao === (data.formacao || '') && novoPerfil === (data.perfil || '')) { semMudanca++; continue; }

        if (APPLY) await doc.ref.set({ formacao: novaFormacao, perfil: novoPerfil, updatedAt: Timestamp.now() }, { merge: true });
        console.log(`  ${APPLY ? '' : '(simulação) '}${productId}/${eventoDoc.id}/${doc.id}: perfil="${data.perfil || ''}"→"${novoPerfil}" formacao="${data.formacao || ''}"→"${novaFormacao}"`);
        atualizados++;
      }
    }
  }

  console.log(`\nInscritos varridos: ${totalInscritos} | atualizados: ${atualizados} | fora do período: ${semPedidoNoPeriodo} | sem mudança: ${semMudanca}`);
  avisoSimulacao();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
