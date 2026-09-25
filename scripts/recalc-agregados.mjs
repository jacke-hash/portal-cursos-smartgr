// Reconta totalInscritos/confirmados de cada evento a partir da subcoleção
// real de inscritos, e corrige o doc do evento se tiver desalinhado.
//
// O worker de webhook usa delta (+1/-1) em vez de reler tudo a cada pedido
// (ver workers/shopify-webhook/src/index.js) — muito mais barato em leitura,
// mas sem recontagem periódica um delta perdido (ex.: escrita que falhou por
// cota excedida) nunca se autocorrige sozinho. Este script é esse
// autoconserto: roda sob demanda ou periodicamente (não a cada poucos
// minutos — lê a subcoleção inteira de cada evento, então tem custo real).
//
// Uso: node scripts/recalc-agregados.mjs

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const INACTIVE_STATUS_LABELS = new Set([
  'Cancelado', 'Reembolsado', 'Parcialmente Reembolsado',
  'Expirado', 'Pendente', 'Autorizado', 'Anulado',
]);
function isInscritoAtivo(i) {
  if (i.financialStatus) return i.financialStatus === 'paid';
  return !INACTIVE_STATUS_LABELS.has(i.status);
}
function isConfirmado(i) {
  return i.status === 'Confirmado' || i.status === 'Presente';
}

async function main() {
  let eventosVarridos = 0, corrigidos = 0;

  for (const [productId, nome] of KNOWN_COURSES) {
    const eventosSnap = await db.collection('cursos').doc(String(productId)).collection('eventos').get();

    for (const eventoDoc of eventosSnap.docs) {
      eventosVarridos++;
      const inscritosSnap = await eventoDoc.ref.collection('inscritos').get();
      const inscritos = inscritosSnap.docs.map(d => d.data());
      const ativos = inscritos.filter(isInscritoAtivo);
      // Conta ingressos (soma de quantidade), não pedidos — mesmo critério
      // do worker e do painel do evento (eventoInsights).
      const qty = i => Number(i.quantidade) || 1;
      const totalReal = ativos.reduce((s, i) => s + qty(i), 0);
      const confirmadosReal = ativos.filter(isConfirmado).reduce((s, i) => s + qty(i), 0);

      const atual = eventoDoc.data();
      const totalSalvo = atual.totalInscritos || 0;
      const confirmadosSalvo = atual.confirmados || 0;

      // ativo/encerrado só são recalculados quando um pedido novo mexe no
      // evento (worker) ou quando alguém roda sync-shopify.mjs manualmente
      // — um evento com data já passada e sem pedido recente ficava com
      // ativo:true desatualizado pra sempre, aparecendo na tela como
      // "futuro" mesmo com o badge já mostrando "Encerrado" (calculado à
      // parte, pela data). Só corrige nessa direção (ativo→encerrado quando
      // a data já passou); nunca reativa um evento já marcado inativo —
      // sync-shopify.mjs também desativa eventos removidos da Shopify
      // (órfãos) por outro motivo além da data, e mexer nisso aqui poderia
      // reverter essa desativação por engano.
      const evDate = atual.data?.toDate?.() || null;
      let ativoCorreto = atual.ativo;
      let encerradoCorreto = atual.encerrado;
      if (evDate && atual.ativo === true) {
        const hoje = new Date();
        const evDay   = new Date(evDate.getFullYear(), evDate.getMonth(), evDate.getDate());
        const hojeDay = new Date(hoje.getFullYear(),  hoje.getMonth(),  hoje.getDate());
        if (evDay <= hojeDay) { ativoCorreto = false; encerradoCorreto = true; }
      }

      const precisaAtualizarStatus = ativoCorreto !== atual.ativo || encerradoCorreto !== atual.encerrado;
      if (totalSalvo === totalReal && confirmadosSalvo === confirmadosReal && !precisaAtualizarStatus) continue;

      const patch = { totalInscritos: totalReal, confirmados: confirmadosReal, updatedAt: Timestamp.now() };
      if (precisaAtualizarStatus) { patch.ativo = ativoCorreto; patch.encerrado = encerradoCorreto; }

      await eventoDoc.ref.set(patch, { merge: true });
      const statusMsg = precisaAtualizarStatus ? ` | ativo ${atual.ativo}→${ativoCorreto}, encerrado ${atual.encerrado}→${encerradoCorreto}` : '';
      console.log(`  ${nome} / ${atual.varianteTitle || eventoDoc.id}: totalInscritos ${totalSalvo}→${totalReal} | confirmados ${confirmadosSalvo}→${confirmadosReal}${statusMsg}`);
      corrigidos++;
    }
  }

  console.log(`\nEventos varridos: ${eventosVarridos} | corrigidos: ${corrigidos}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
