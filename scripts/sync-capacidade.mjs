// Sincroniza `capacidadeDisponivel` (estoque "disponível" na Shopify, mesmo
// número mostrado em Produtos → Estoque) nos eventos já existentes. Só busca
// variantes (leve, ~16 produtos) — não pagina pedidos como sync-shopify.mjs.
//
// Existe como job recorrente (ver .github/workflows/sync-capacidade.yml) e
// não só reativo a pedido: "disponível" muda por fulfillment, ajuste manual
// de estoque etc. — coisas que não disparam o webhook de pedidos, então só
// atualizar via webhook deixava o número parado (ex.: 101 salvo, Shopify já
// em 50 por causa de pedidos marcados como "comprometido"/fulfillment).
//
// Uso: node scripts/sync-capacidade.mjs

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'smart-gr-pro.myshopify.com';
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_BASE = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;

// Mesmo padrão de credenciais do sync-google-sheets.mjs/reconciliacao-pedidos.mjs:
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

async function main() {
  let atualizados = 0, semEvento = 0, semNumero = 0;

  for (const [productId, nome] of KNOWN_COURSES) {
    const resp = await fetch(`${SHOPIFY_BASE}/products/${productId}/variants.json?limit=250`, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
    });
    if (!resp.ok) {
      console.log(`  ${nome}: erro Shopify ${resp.status}`);
      continue;
    }
    const { variants } = await resp.json();
    console.log(`\n${nome} (${productId}) — ${variants.length} variante(s)`);

    for (const variant of variants) {
      const eventoRef = db.collection('cursos').doc(String(productId)).collection('eventos').doc(String(variant.id));
      const snap = await eventoRef.get();
      if (!snap.exists) { semEvento++; continue; }
      if (typeof variant.inventory_quantity !== 'number') { semNumero++; continue; }

      // Só escreve quando muda — job roda a cada poucos minutos, não faz
      // sentido bater Firestore (e disparar o listener em tela) à toa.
      if (snap.data().capacidadeDisponivel === variant.inventory_quantity) continue;

      await eventoRef.set({ capacidadeDisponivel: variant.inventory_quantity, updatedAt: Timestamp.now() }, { merge: true });
      console.log(`  ✓ ${variant.title}: capacidadeDisponivel = ${variant.inventory_quantity}`);
      atualizados++;
    }
  }

  console.log(`\nAtualizados: ${atualizados} | sem evento no Firestore: ${semEvento} | sem número de estoque: ${semNumero}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
