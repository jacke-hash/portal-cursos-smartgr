/**
 * fix-confirmados-agregado.mjs
 *
 * Corrige o campo agregado `confirmados` em cursos/{cursoId}/eventos/{eventoId}.
 *
 * Antigamente esse agregado ficava desatualizado porque nenhuma escrita disparava
 * recálculo quando um inscrito mudava de status para "Confirmado"/"Presente" pelo roster
 * — só o fluxo de pedido Shopify recalculava (sync-shopify.mjs e o worker de webhook).
 * Isso já foi corrigido: `updateInscrito` (src/services/firestore.js) agora recalcula
 * `confirmados` automaticamente em background sempre que o `status` de um inscrito muda.
 *
 * Este script continua existindo para:
 *   1. Corrigir divergências históricas gravadas antes da automação acima existir.
 *   2. Servir de reconciliação eventual, caso o recálculo automático falhe silenciosamente
 *      (erros são só logados no console do navegador, nunca bloqueiam a ação do usuário).
 *
 * O card de listagem de eventos não depende deste campo para exibir o número (calcula
 * "confirmados" em tempo real a partir da subcoleção `inscritos`, igual ao roster) — uma
 * divergência aqui não quebra a UI, só afeta quem lê o Firestore bruto (exports, relatórios).
 *
 * O critério de "confirmado" precisa ficar idêntico ao usado em src/components/app.js
 * (inscritosStats), src/services/firestore.js (recalcConfirmados) e scripts/sync-shopify.mjs
 * (isConfirmado) — se um mudar, mude os quatro.
 *
 * Uso:
 *   node scripts/fix-confirmados-agregado.mjs           # dry-run: só mostra divergências
 *   node scripts/fix-confirmados-agregado.mjs --apply   # grava as correções
 */

import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ACCOUNT_PATH = join(__dirname, '..', 'service-account.json');
const APPLY = process.argv.includes('--apply');

if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('service-account.json não encontrado na raiz do projeto');
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// Statuses derivados da Shopify que indicam inscrito inativo (não pago) — mesma lista de
// src/components/app.js (INACTIVE_STATUS_LABELS) e scripts/sync-shopify.mjs.
const INACTIVE_STATUS_LABELS = new Set([
  'Cancelado', 'Reembolsado', 'Parcialmente Reembolsado',
  'Expirado', 'Pendente', 'Autorizado', 'Anulado',
]);

// Mapeia financial_status/status já gravados no doc do inscrito → financialStatus canônico.
function resolveFinancialStatus(data) {
  if (data.financialStatus) return data.financialStatus;
  if (data.status === 'Cancelado') return 'cancelled';
  if (data.status === 'Reembolsado') return 'refunded';
  if (data.status === 'Parcialmente Reembolsado') return 'partially_refunded';
  if (data.status === 'Expirado') return 'expired';
  if (data.status === 'Pendente') return 'pending';
  if (data.status === 'Autorizado') return 'authorized';
  if (data.status === 'Anulado') return 'voided';
  return 'paid'; // assume pago se não há indicação de inativo
}

function isAtivoData(data) {
  return resolveFinancialStatus(data) === 'paid';
}

function isConfirmado(status) {
  return status === 'Confirmado' || status === 'Presente';
}

async function fixConfirmados() {
  console.log('=== Correção retroativa: confirmados ===');
  console.log(`Modo: ${APPLY ? 'APLICAR (grava no Firestore)' : 'DRY-RUN (nenhuma gravação)'}\n`);

  const cursosSnap = await db.collection('cursos').get();
  console.log(`Cursos encontrados: ${cursosSnap.size}\n`);

  let totalEventos = 0;
  const divergencias = []; // { cursoNome, eventoId, varianteTitle, antigo, novo, ref }

  for (const cursoDoc of cursosSnap.docs) {
    const cursoId   = cursoDoc.id;
    const cursoNome = cursoDoc.data().nome || cursoId;
    const eventosSnap = await cursoDoc.ref.collection('eventos').get();

    for (const eventoDoc of eventosSnap.docs) {
      totalEventos++;
      const evento = eventoDoc.data();
      const inscritosSnap = await eventoDoc.ref.collection('inscritos').get();
      const allDocs = inscritosSnap.docs;

      const confirmadosCorreto = allDocs.filter(
        d => isAtivoData(d.data()) && isConfirmado(d.data().status)
      ).length;
      const confirmadosAtual = evento.confirmados || 0;

      if (confirmadosAtual !== confirmadosCorreto) {
        divergencias.push({
          cursoNome,
          eventoId: eventoDoc.id,
          varianteTitle: evento.varianteTitle || eventoDoc.id,
          antigo: confirmadosAtual,
          novo: confirmadosCorreto,
          ref: eventoDoc.ref,
        });
      }
    }
  }

  console.log('=== Resumo ===');
  console.log(`Total de eventos verificados: ${totalEventos}`);
  console.log(`Divergências encontradas    : ${divergencias.length}\n`);

  if (divergencias.length) {
    console.log('Curso / Evento                                          | Antigo | Novo | ID do evento');
    console.log('---------------------------------------------------------------------------------------');
    for (const d of divergencias) {
      const label = `${d.cursoNome} / ${d.varianteTitle}`.slice(0, 55).padEnd(55);
      console.log(`${label} | ${String(d.antigo).padStart(6)} | ${String(d.novo).padStart(4)} | ${d.eventoId}`);
    }
    console.log('');
  }

  if (!APPLY) {
    console.log('[DRY-RUN] Nenhuma alteração foi gravada.');
    console.log('Execute com --apply para gravar as correções.\n');
    return;
  }

  if (!divergencias.length) {
    console.log('Nada a corrigir. Firestore já está correto.\n');
    return;
  }

  console.log(`Gravando ${divergencias.length} correção(ões)...`);
  for (const d of divergencias) {
    await d.ref.update({ confirmados: d.novo, updatedAt: Timestamp.now() });
  }
  console.log(`\n=== Concluído! ${divergencias.length} evento(s) corrigido(s). ===\n`);
}

fixConfirmados().catch(err => {
  console.error('\nErro fatal:', err.message || err);
  process.exit(1);
});
