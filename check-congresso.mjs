import { initializeApp } from 'firebase-admin/app';
import { cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';

const sa = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const PRODUCT_ID = '8928830193821'; // 8º Congresso
const pedidosShopify = [
  'SPFY20349','SPFY20323','SPFY20322','SPFY18199',
  'SPFY16890','SPFY16884','SPFY16580','SPFY16579','SPFY16578'
];

const cursoRef = db.collection('cursos').doc(PRODUCT_ID);
const eventosSnap = await cursoRef.collection('eventos').get();

let todosInscritos = [];
for (const ev of eventosSnap.docs) {
  const inscritosSnap = await ev.ref.collection('inscritos').get();
  inscritosSnap.forEach(d => {
    todosInscritos.push({ pedido: d.data().pedido, eventoId: ev.id, varianteTitle: ev.data().varianteTitle });
  });
}

console.log('--- Checagem pedido por pedido ---');
for (const p of pedidosShopify) {
  const found = todosInscritos.filter(i => i.pedido === p);
  console.log(p, '->', found.length ? JSON.stringify(found) : '❌ NÃO ENCONTRADO NO FIRESTORE');
}

process.exit(0);
