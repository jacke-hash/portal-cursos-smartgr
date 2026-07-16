/**
 * migrate-cpf.mjs
 *
 * Rotina única de backfill: preenche o campo `cpf` dos inscritos legados que
 * ainda não o possuem, buscando o metafield custom.cpf do cliente Shopify
 * correspondente ao pedido.
 *
 * Idempotente: pula todo inscrito que já tenha `cpf` preenchido — pode ser
 * executada novamente sem risco (nada é reprocessado nem sobrescrito).
 *
 * Não apaga nada. Não altera nenhum outro campo do inscrito.
 *
 * Uso:
 *   node scripts/migrate-cpf.mjs           # aplica o backfill
 *   node scripts/migrate-cpf.mjs --dry-run # mostra o que seria feito, sem gravar
 */

import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ACCOUNT_PATH = join(__dirname, '..', 'service-account.json');
const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.SHOPIFY_ACCESS_TOKEN) {
  console.error('SHOPIFY_ACCESS_TOKEN não encontrado no .env');
  process.exit(1);
}
if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('service-account.json não encontrado na raiz do projeto');
  process.exit(1);
}

const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'smart-gr-pro.myshopify.com';
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_BASE = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };
}

async function shopifyGet(url) {
  const resp = await fetch(url, { headers: shopifyHeaders() });
  if (!resp.ok) throw new Error(`Shopify API ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Busca o metafield custom.cpf do cliente. Nunca lança erro — retorna '' em qualquer falha.
const cpfCache = new Map();
async function getCustomerCpf(customerId) {
  if (!customerId) return '';
  if (cpfCache.has(customerId)) return cpfCache.get(customerId);
  let cpf = '';
  try {
    const data = await shopifyGet(
      `${SHOPIFY_BASE}/customers/${customerId}/metafields.json?namespace=custom&key=cpf`
    );
    cpf = data.metafields?.[0]?.value || '';
  } catch (e) {
    console.log(`  Aviso: falha ao buscar CPF do cliente ${customerId}: ${e.message}`);
  }
  cpfCache.set(customerId, cpf);
  // Respeita o rate limit da Shopify (~2 req/s) — só pausa em chamadas reais à API.
  await sleep(550);
  return cpf;
}

async function migrate() {
  console.log('=== Migração de CPF — inscritos legados ===');
  console.log(`Modo: ${DRY_RUN ? 'DRY-RUN (nenhuma escrita)' : 'EXECUÇÃO REAL'}`);
  console.log(`Início: ${new Date().toISOString()}\n`);

  // 1. Coleta todos os inscritos sem CPF preenchido (idempotente: pula quem já tem)
  const cursosSnap = await db.collection('cursos').get();
  console.log(`Cursos encontrados: ${cursosSnap.size}`);

  const pendentes = []; // { ref, shopifyId, pedido }
  let totalDocs = 0;
  let jaPossuiCpf = 0;

  for (const cursoDoc of cursosSnap.docs) {
    const eventosSnap = await cursoDoc.ref.collection('eventos').get();
    for (const eventoDoc of eventosSnap.docs) {
      const inscritosSnap = await eventoDoc.ref.collection('inscritos').get();
      for (const inscritoDoc of inscritosSnap.docs) {
        totalDocs++;
        const data = inscritoDoc.data();
        if (data.cpf) { jaPossuiCpf++; continue; } // já preenchido — não reprocessa, não sobrescreve
        if (!data.shopifyId) continue;
        pendentes.push({ ref: inscritoDoc.ref, shopifyId: data.shopifyId, pedido: data.pedido || inscritoDoc.id });
      }
    }
  }

  console.log(`Total de inscritos: ${totalDocs}`);
  console.log(`Já possuem CPF (ignorados): ${jaPossuiCpf}`);
  console.log(`Pendentes de backfill: ${pendentes.length}\n`);

  if (pendentes.length === 0) {
    console.log('Nada a fazer — todos os inscritos elegíveis já possuem CPF. Migração concluída.');
    return;
  }

  // 2. Busca em lote o customer.id de cada pedido na Shopify
  console.log('=== Resolvendo customer.id de cada pedido (lotes de 250) ===');
  const distinctOrderIds = [...new Set(pendentes.map(p => p.shopifyId))];
  const orderCustomerMap = new Map(); // orderId → customerId (ou null se guest checkout)
  const CHUNK = 250;
  for (let i = 0; i < distinctOrderIds.length; i += CHUNK) {
    const chunk = distinctOrderIds.slice(i, i + CHUNK);
    try {
      const data = await shopifyGet(
        `${SHOPIFY_BASE}/orders.json?ids=${chunk.join(',')}&status=any&fields=id,customer&limit=${CHUNK}`
      );
      for (const o of data.orders || []) {
        orderCustomerMap.set(String(o.id), o.customer?.id || null);
      }
      console.log(`  Lote ${Math.floor(i / CHUNK) + 1}: ${data.orders?.length || 0} pedido(s) resolvido(s)`);
    } catch (e) {
      console.log(`  Erro ao buscar lote de pedidos: ${e.message}`);
    }
  }
  console.log(`Pedidos resolvidos: ${orderCustomerMap.size} / ${distinctOrderIds.length}\n`);

  // 3. Para cada inscrito pendente, busca o CPF do cliente (com cache) e grava SOMENTE o campo cpf
  console.log(`=== Buscando CPF por cliente e ${DRY_RUN ? 'simulando gravação' : 'gravando'} ===`);
  let atualizados = 0, semCpf = 0, pedidoNaoEncontrado = 0, semCliente = 0, erros = 0;

  for (const { ref, shopifyId, pedido } of pendentes) {
    if (!orderCustomerMap.has(shopifyId)) { pedidoNaoEncontrado++; continue; }
    const customerId = orderCustomerMap.get(shopifyId);
    if (!customerId) { semCliente++; continue; } // pedido sem conta de cliente associada

    const cpf = await getCustomerCpf(customerId);
    if (!cpf) { semCpf++; continue; }

    if (DRY_RUN) {
      console.log(`  [dry-run] ${pedido}: receberia CPF`);
      atualizados++;
      continue;
    }

    try {
      await ref.update({ cpf }); // grava SOMENTE o campo cpf — nenhum outro dado é tocado
      console.log(`  ✓ ${pedido}: CPF preenchido`);
      atualizados++;
    } catch (e) {
      console.log(`  ✗ Erro ao gravar CPF em ${pedido}: ${e.message}`);
      erros++;
    }
  }

  console.log('\n=== Resumo ===');
  console.log(`Total de inscritos:                 ${totalDocs}`);
  console.log(`Já possuíam CPF:                     ${jaPossuiCpf}`);
  console.log(`${DRY_RUN ? 'Receberiam' : 'Atualizados com'} CPF:              ${atualizados}`);
  console.log(`Sem CPF cadastrado na Shopify:        ${semCpf}`);
  console.log(`Sem cliente associado (guest):        ${semCliente}`);
  console.log(`Pedido não encontrado na Shopify:     ${pedidoNaoEncontrado}`);
  console.log(`Erros de gravação:                    ${erros}`);
  console.log(`Fim: ${new Date().toISOString()}`);
}

migrate().catch(err => {
  console.error('\nErro fatal durante a migração:', err.message || err);
  process.exit(1);
});
