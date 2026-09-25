// Backfill do campo `especialidade` (especialidade_cliente na Shopify) pros
// inscritos que já existem. Só médico/dentista têm esse dado — os demais
// ficam vazios de propósito, não é bug.
// Mesmo padrão de backfill-cpf.mjs: busca pedidos em lote por período e casa
// por shopifyId, em vez de 1 chamada por inscrito.
//
// Uso: node scripts/backfill-especialidade.mjs [--from=2015-01-01] [--to=2026-09-25]
// Sem argumentos: desde o início até hoje.

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));

const argFrom = process.argv.find(a => a.startsWith('--from='))?.split('=')[1];
const argTo   = process.argv.find(a => a.startsWith('--to='))?.split('=')[1];
const FROM = argFrom ? new Date(`${argFrom}T00:00:00.000Z`) : new Date('2015-01-01T00:00:00.000Z');
const TO   = argTo   ? new Date(`${argTo}T23:59:59.999Z`)   : new Date();

const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'smart-gr-pro.myshopify.com';
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_BASE = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;

function lerServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const localPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || resolve(__dirname, '..', 'service-account.json');
  return JSON.parse(readFileSync(localPath, 'utf8'));
}

initializeApp({ credential: cert(lerServiceAccount()) });
const db = getFirestore();

const KNOWN_COURSES = new Map([
  [8821788115101, 'Treinamento Prático - Prisma Peeling'],
  [8821788180637, 'Treinamento Presencial - Protocolo Peptídeos'],
  [8701283827869, 'Terapias Médicas Baseadas em Eletroporação'],
  [8680458551453, 'Treinamento Presencial de Microagulhamento'],
  [8955598438557, 'Presencial - Pocket Microagulhamento'],
  [8695759601821, 'SMART DAY'],
  [8928830193821, '8° Congresso'],
  [8958883791005, 'Smart Tecnologias - Atualização sobre equipamentos na Medicina Estética'],
  [8958133764253, 'Treinamento Prático: Protocolos Capilares na era de Canetas Emagrecedoras'],
  [8958132125853, 'Treinamento Prático: Agregando tratamentos de Sobrancelhas & Lábios'],
  [8958130454685, 'Treinamento Prático: Prisma Peeling - K Beauty no Gerenciamento de Cicatrizes'],
  [8957017981085, 'Treinamento Presencial de Microagulhamento + Prisma Peeling em Porto Alegre'],
  [8956248555677, 'Treinamento Presencial de Microagulhamento + Prisma Peeling em Porto Alegre'],
  [8956141568157, 'Treinamento Presencial de Microagulhamento + Prisma Peeling em Caxias do Sul'],
  [8680460517533, 'Treinamento Presencial Limpeza de Pele'],
  [8992580731037, 'Prisma Peeling - A Tecnologia do Gerenciamento da Pele Curso Exclusivo com Juliana Gorreri'],
]);

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

function extractEspecialidade(attributes) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  return attributes.find((a) => norm(a.name) === 'especialidade_cliente')?.value?.trim() || '';
}

async function main() {
  console.log(`Janela: ${FROM.toISOString()} → ${TO.toISOString()}`);
  console.log('\nBuscando pedidos da Shopify no período (status=any)...');
  const firstUrl = `${SHOPIFY_BASE}/orders.json?status=any&limit=250&created_at_min=${FROM.toISOString()}&created_at_max=${TO.toISOString()}&fields=id,note_attributes`;
  const orders = await fetchAllPages(firstUrl);
  console.log(`Total de pedidos no período: ${orders.length}`);

  const especialidadeById = new Map();
  for (const order of orders) {
    const esp = extractEspecialidade(order.note_attributes || []);
    if (esp) especialidadeById.set(String(order.id), esp);
  }
  console.log(`Pedidos com especialidade_cliente preenchida: ${especialidadeById.size}`);

  let totalInscritos = 0, atualizados = 0, semEspecialidadeNaShopify = 0, jaTinha = 0;

  for (const productId of KNOWN_COURSES.keys()) {
    const eventosSnap = await db.collection('cursos').doc(String(productId)).collection('eventos').get();
    for (const eventoDoc of eventosSnap.docs) {
      const inscritosSnap = await eventoDoc.ref.collection('inscritos').get();
      for (const doc of inscritosSnap.docs) {
        totalInscritos++;
        const data = doc.data();
        if (data.especialidade) { jaTinha++; continue; }

        const esp = especialidadeById.get(data.shopifyId);
        if (!esp) { semEspecialidadeNaShopify++; continue; }

        await doc.ref.set({ especialidade: esp, updatedAt: Timestamp.now() }, { merge: true });
        console.log(`  ${productId}/${eventoDoc.id}/${doc.id} (${data.pedido}): especialidade = "${esp}"`);
        atualizados++;
      }
    }
  }

  console.log(`\nInscritos varridos: ${totalInscritos} | atualizados: ${atualizados} | já tinha: ${jaTinha} | sem especialidade na Shopify: ${semEspecialidadeNaShopify}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
