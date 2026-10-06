// Backfill do campo `cpf` pros inscritos que ficaram sem — busca pedidos da
// Shopify em lote (por created_at) e casa por shopifyId, igual
// backfill-formacao.mjs. Nunca sobrescreve um CPF já salvo, só preenche
// quando está vazio e a Shopify tem o note_attribute `cpf_cliente`.
//
// Causa provável: o app de checkout grava esses atributos custom um pouco
// depois da Shopify criar o pedido — se nosso webhook processa antes disso
// terminar, o pedido fica sem cpf_cliente no payload que recebemos, e sem
// um evento de atualização posterior isso nunca se autocorrige.
//
// A lista de cursos vem da coleção `cursos` do Firestore (shared/cursos.mjs).
// Sem --apply é SIMULAÇÃO (lista o que seria gravado); grava de fato só com --apply.
//
// Uso: node scripts/backfill-cpf.mjs [--from=2015-01-01] [--to=2026-09-25] [--apply]
// Sem argumentos: desde o início até hoje.

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { loadCursos } from '../shared/cursos.mjs';
import { APPLY, avisoSimulacao } from '../shared/cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const argFrom = process.argv.find(a => a.startsWith('--from='))?.split('=')[1];
const argTo   = process.argv.find(a => a.startsWith('--to='))?.split('=')[1];
const FROM = argFrom ? new Date(`${argFrom}T00:00:00.000Z`) : new Date('2015-01-01T00:00:00.000Z');
const TO   = argTo   ? new Date(`${argTo}T23:59:59.999Z`)   : new Date();

const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'smart-gr-pro.myshopify.com';
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_BASE = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;

// Mesmo padrão de credenciais do sync-capacidade.mjs/recalc-agregados.mjs:
// JSON inteiro via env em CI, arquivo local no dia a dia.
function lerServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const localPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || resolve(__dirname, '..', 'service-account.json');
  return JSON.parse(readFileSync(localPath, 'utf8'));
}

initializeApp({ credential: cert(lerServiceAccount()) });
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

function extractCpf(attributes) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  return attributes.find((a) => norm(a.name) === 'cpf_cliente')?.value?.trim() || '';
}

async function main() {
  const cursos = await loadCursos(db);
  console.log(`Janela: ${FROM.toISOString()} → ${TO.toISOString()}`);
  console.log('\nBuscando pedidos da Shopify no período (status=any)...');
  const firstUrl = `${SHOPIFY_BASE}/orders.json?status=any&limit=250&created_at_min=${FROM.toISOString()}&created_at_max=${TO.toISOString()}&fields=id,note_attributes`;
  const orders = await fetchAllPages(firstUrl);
  console.log(`Total de pedidos no período: ${orders.length}`);

  const cpfById = new Map();
  for (const order of orders) {
    const cpf = extractCpf(order.note_attributes || []);
    if (cpf) cpfById.set(String(order.id), cpf);
  }
  console.log(`Pedidos com cpf_cliente preenchido: ${cpfById.size}`);

  let totalInscritos = 0, atualizados = 0, semCpfNaShopify = 0, jaTinha = 0;

  for (const productId of cursos.keys()) {
    const eventosSnap = await db.collection('cursos').doc(String(productId)).collection('eventos').get();
    for (const eventoDoc of eventosSnap.docs) {
      const inscritosSnap = await eventoDoc.ref.collection('inscritos').get();
      for (const doc of inscritosSnap.docs) {
        totalInscritos++;
        const data = doc.data();
        if (data.cpf) { jaTinha++; continue; }

        const cpf = cpfById.get(data.shopifyId);
        if (!cpf) { semCpfNaShopify++; continue; }

        if (APPLY) await doc.ref.set({ cpf, updatedAt: Timestamp.now() }, { merge: true });
        console.log(`  ${APPLY ? '' : '(simulação) '}${productId}/${eventoDoc.id}/${doc.id} (${data.pedido}): cpf = "${cpf}"`);
        atualizados++;
      }
    }
  }

  console.log(`\nInscritos varridos: ${totalInscritos} | atualizados: ${atualizados} | já tinha CPF: ${jaTinha} | sem CPF na Shopify: ${semCpfNaShopify}`);
  avisoSimulacao();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
