// Preenche o campo `cupom` dos inscritos existentes a partir de order.discount_codes
// da Shopify. Só toca inscritos sem o campo (nunca sobrescreve); grava '' quando o
// pedido não usou código, pra não reprocessar na próxima execução.
// Sem --apply é SIMULAÇÃO. Uso: node scripts/backfill-cupons.mjs [--apply]

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { loadCursos } from '../shared/cursos.mjs';
import { extractCupom } from '../shared/eventos.mjs';
import { APPLY, avisoSimulacao } from '../shared/cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const BASE = 'https://smart-gr-pro.myshopify.com/admin/api/2024-01';
const CHUNK = 50;
if (!TOKEN) { console.error('SHOPIFY_ACCESS_TOKEN ausente'); process.exit(1); }

initializeApp({ credential: cert(JSON.parse(readFileSync(join(__dirname, '..', 'service-account.json'), 'utf8'))) });
const db = getFirestore();

async function shopifyGet(url) {
  const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
  if (resp.status === 429) { await new Promise(r => setTimeout(r, 2000)); return shopifyGet(url); }
  if (!resp.ok) throw new Error(`Shopify ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function main() {
  const cursos = await loadCursos(db);

  // 1. Inscritos sem o campo `cupom`, agrupados por pedido
  const pendentes = new Map(); // shopifyId → [refs]
  let total = 0;
  for (const [productId] of cursos) {
    const eventos = await db.collection('cursos').doc(String(productId)).collection('eventos').get();
    for (const ev of eventos.docs) {
      const insc = await ev.ref.collection('inscritos').get();
      for (const d of insc.docs) {
        total++;
        const x = d.data();
        if (x.cupom !== undefined || !x.shopifyId) continue;
        if (!pendentes.has(x.shopifyId)) pendentes.set(x.shopifyId, []);
        pendentes.get(x.shopifyId).push(d.ref);
      }
    }
  }
  console.log(`Inscritos: ${total} | sem campo cupom: ${[...pendentes.values()].flat().length} (${pendentes.size} pedidos)`);

  // 2. Cupom de cada pedido na Shopify
  const ids = [...pendentes.keys()];
  const cupomPorPedido = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { orders } = await shopifyGet(`${BASE}/orders.json?ids=${chunk.join(',')}&status=any&fields=id,discount_codes&limit=${CHUNK}`);
    for (const o of orders || []) cupomPorPedido.set(String(o.id), extractCupom(o));
    console.log(`  Shopify: ${Math.min(i + CHUNK, ids.length)}/${ids.length} pedidos`);
  }

  // 3. Grava
  const writer = APPLY ? db.bulkWriter() : null;
  const contagem = new Map();
  let naoEncontrados = 0, gravados = 0;
  for (const [pedidoId, refs] of pendentes) {
    if (!cupomPorPedido.has(pedidoId)) { naoEncontrados += refs.length; continue; }
    const cupom = cupomPorPedido.get(pedidoId);
    contagem.set(cupom || '(sem cupom)', (contagem.get(cupom || '(sem cupom)') || 0) + refs.length);
    for (const ref of refs) {
      gravados++;
      if (writer) writer.set(ref, { cupom, updatedAt: Timestamp.now() }, { merge: true });
    }
  }
  if (writer) await writer.close();

  console.log(`\n${APPLY ? 'Gravados' : 'Seriam gravados'}: ${gravados} | pedido não encontrado na Shopify: ${naoEncontrados}`);
  [...contagem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([c, n]) => console.log(`  ${String(n).padStart(5)}  ${c}`));
  avisoSimulacao();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
