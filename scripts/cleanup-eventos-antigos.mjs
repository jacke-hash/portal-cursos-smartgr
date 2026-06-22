/**
 * cleanup-eventos-antigos.mjs
 *
 * Percorre todos os documentos cursos/*/eventos/* no Firestore e:
 *   - marca como  { ativo: false, encerrado: true }  os eventos com data <= hoje
 *   - marca como  { ativo: true,  encerrado: false } os eventos futuros que porventura
 *     estejam com o campo incorreto
 *
 * Não apaga nada. Não toca em inscritos.
 *
 * Uso:
 *   node scripts/cleanup-eventos-antigos.mjs           # aplica as correções
 *   node scripts/cleanup-eventos-antigos.mjs --dry-run # mostra o que seria feito, sem gravar
 */

import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ACCOUNT_PATH = join(__dirname, '..', 'service-account.json');
const DRY_RUN = process.argv.includes('--dry-run');

if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('service-account.json não encontrado na raiz do projeto');
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// Evento encerrado quando a data de calendário é <= hoje (inclui o próprio dia)
function isEventoEncerrado(date) {
  if (!date) return false;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const evDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return evDay <= hoje;
}

// Commit em batches de até 499 (limite Firestore: 500)
async function commitBatches(updates) {
  const BATCH_SIZE = 499;
  let committed = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const chunk = updates.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const { ref, data } of chunk) {
      batch.update(ref, data);
    }
    await batch.commit();
    committed += chunk.length;
    console.log(`  [batch] ${committed}/${updates.length} atualizações gravadas`);
  }
}

async function cleanup() {
  const now = new Date();
  const label = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  console.log('=== Limpeza de Eventos Antigos ===');
  console.log(`Data de referência : ${label}`);
  console.log(`Modo               : ${DRY_RUN ? 'DRY-RUN (sem gravação)' : 'PRODUÇÃO'}\n`);

  const cursosSnap = await db.collection('cursos').get();
  console.log(`Cursos encontrados : ${cursosSnap.size}\n`);

  let totalEventos      = 0;
  let semData           = 0;
  let jaCorretos        = 0;
  const toMarkEncerrado = [];   // { ref, varianteTitle, dataLabel }
  const toMarkAtivo     = [];   // { ref, varianteTitle, dataLabel }

  for (const cursoDoc of cursosSnap.docs) {
    const nomeCurso = cursoDoc.data().nome || cursoDoc.id;
    const eventosSnap = await cursoDoc.ref.collection('eventos').get();
    console.log(`${nomeCurso} (${eventosSnap.size} eventos)`);

    for (const eventoDoc of eventosSnap.docs) {
      totalEventos++;
      const ev       = eventoDoc.data();
      const titulo   = ev.varianteTitle || eventoDoc.id;
      const evDate   = ev.data?.toDate?.() ?? null;

      if (!evDate) {
        semData++;
        console.log(`  ○  ${titulo} — sem data, ignorado`);
        continue;
      }

      const dateLabel   = evDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const deveEncerrar = isEventoEncerrado(evDate);

      if (deveEncerrar) {
        if (ev.ativo === false && ev.encerrado === true) {
          jaCorretos++;
          console.log(`  ✓  ${titulo} (${dateLabel}) — já encerrado`);
        } else {
          toMarkEncerrado.push({ ref: eventoDoc.ref, varianteTitle: titulo, dataLabel: dateLabel });
          console.log(`  ✗  ${titulo} (${dateLabel}) — MARCAR encerrado`);
        }
      } else {
        if (ev.ativo !== true || ev.encerrado !== false) {
          toMarkAtivo.push({ ref: eventoDoc.ref, varianteTitle: titulo, dataLabel: dateLabel });
          console.log(`  →  ${titulo} (${dateLabel}) — corrigir para ativo`);
        } else {
          jaCorretos++;
          console.log(`  ✓  ${titulo} (${dateLabel}) — ativo (correto)`);
        }
      }
    }

    console.log('');
  }

  console.log('=== Resumo ===');
  console.log(`Total de eventos   : ${totalEventos}`);
  console.log(`Sem data (ignorados): ${semData}`);
  console.log(`Já corretos        : ${jaCorretos}`);
  console.log(`Marcar encerrado   : ${toMarkEncerrado.length}`);
  console.log(`Corrigir para ativo: ${toMarkAtivo.length}`);

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] Nenhuma alteração foi gravada.');
    console.log('Execute sem --dry-run para aplicar as correções.\n');
    return;
  }

  const allUpdates = [
    ...toMarkEncerrado.map(u => ({
      ref: u.ref,
      data: { ativo: false, encerrado: true, updatedAt: Timestamp.now() },
    })),
    ...toMarkAtivo.map(u => ({
      ref: u.ref,
      data: { ativo: true, encerrado: false, updatedAt: Timestamp.now() },
    })),
  ];

  if (allUpdates.length === 0) {
    console.log('\nNada a atualizar. Firestore já está correto.\n');
    return;
  }

  console.log(`\nGravando ${allUpdates.length} atualizações...`);
  await commitBatches(allUpdates);

  console.log(`\n=== Concluído! ${allUpdates.length} evento(s) corrigido(s). ===\n`);
}

cleanup().catch(err => {
  console.error('\nErro fatal:', err.message || err);
  process.exit(1);
});
