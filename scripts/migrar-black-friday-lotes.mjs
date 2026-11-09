// Aula Master + Maratona Black Friday: move os inscritos do evento legado "Online"
// (variante única já removida da Shopify) para os lotes reais:
//   precoCatalogo >= 99 (virada de 28/10, pagos e grátis) → 2º lote
//   demais                                              → 1º lote (esgotado)
// Depois recalcula agregados e remove o evento legado (vazio).
// Grava backup JSON dos inscritos em scripts/backup-black-friday-online.json.
// Sem --apply é SIMULAÇÃO. Uso: node scripts/migrar-black-friday-lotes.mjs [--apply]

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { APPLY, avisoSimulacao } from '../shared/cli.mjs';
import { VARIANTE_LEGADA_BLACK_FRIDAY as CFG, PRECO_VIRADA_LOTE2 } from '../shared/eventos.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCT_ID = '15418735362091';

initializeApp({ credential: cert(JSON.parse(readFileSync(join(__dirname, '..', 'service-account.json'), 'utf8'))) });
const db = getFirestore();
const cursoRef = db.collection('cursos').doc(PRODUCT_ID);

function qtyOf(i) {
  const q = i?.quantidade;
  if (q == null || (typeof q === 'string' && q.trim() === '')) return 1;
  const n = Number(q);
  return Number.isNaN(n) ? 1 : Math.max(0, n);
}

async function recalcEvento(variantId) {
  const ref = cursoRef.collection('eventos').doc(variantId);
  const inscritos = (await ref.collection('inscritos').get()).docs.map(d => d.data());
  const ativos = inscritos.filter(i => i.financialStatus === 'paid');
  const totalInscritos = ativos.reduce((s, i) => s + qtyOf(i), 0);
  const confirmados = ativos.filter(i => i.status === 'Confirmado' || i.status === 'Presente').reduce((s, i) => s + qtyOf(i), 0);
  console.log(`  evento ${variantId}: totalInscritos=${totalInscritos} confirmados=${confirmados}`);
  await ref.set({ totalInscritos, confirmados, updatedAt: Timestamp.now() }, { merge: true });
}

async function main() {
  const legadoRef = cursoRef.collection('eventos').doc(CFG.legada);
  const snap = await legadoRef.collection('inscritos').get();
  console.log(`Inscritos no evento legado: ${snap.size}`);

  const plano = snap.docs.map(d => {
    const x = d.data();
    const destino = (Number(x.precoCatalogo) || 0) >= PRECO_VIRADA_LOTE2 ? CFG.lote2 : CFG.lote1;
    return { oldRef: d.ref, data: x, destino, newId: `${x.shopifyId}-${destino.id}` };
  });
  for (const lote of [CFG.lote1, CFG.lote2]) {
    const ps = plano.filter(p => p.destino === lote);
    console.log(`  → ${lote.titulo}: ${ps.length} pedido(s), ${ps.reduce((s, p) => s + qtyOf(p.data), 0)} ingresso(s)`);
  }

  if (APPLY) {
    const bak = join(__dirname, 'backup-black-friday-online.json');
    writeFileSync(bak, JSON.stringify(plano.map(p => ({ id: p.oldRef.id, ...p.data })), null, 2));
    console.log(`Backup: ${bak}`);

    const writer = db.bulkWriter();
    for (const p of plano) {
      const newRef = cursoRef.collection('eventos').doc(p.destino.id).collection('inscritos').doc(p.newId);
      writer.set(newRef, { ...p.data, variantId: p.destino.id, variante: p.destino.titulo, updatedAt: Timestamp.now() });
    }
    await writer.close();

    // Confere a cópia antes de apagar os originais
    for (const lote of [CFG.lote1, CFG.lote2]) {
      const esperado = plano.filter(p => p.destino === lote).length;
      const atual = (await cursoRef.collection('eventos').doc(lote.id).collection('inscritos').get())
        .docs.filter(d => plano.some(p => p.newId === d.id)).length;
      if (atual !== esperado) throw new Error(`Cópia incompleta em ${lote.titulo}: ${atual}/${esperado} — originais mantidos`);
    }

    const del = db.bulkWriter();
    for (const p of plano) del.delete(p.oldRef);
    await del.close();
    await legadoRef.delete();
    console.log('Originais e evento legado removidos.');

    await recalcEvento(CFG.lote1.id);
    await recalcEvento(CFG.lote2.id);
    const eventos = await cursoRef.collection('eventos').get();
    await cursoRef.set({
      totalInscritos: eventos.docs.reduce((s, d) => s + (d.data().totalInscritos || 0), 0),
      totalEventos: eventos.size,
      totalEventosAtivos: eventos.docs.filter(d => d.data().ativo === true).length,
      updatedAt: Timestamp.now(),
    }, { merge: true });
  }

  avisoSimulacao();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
