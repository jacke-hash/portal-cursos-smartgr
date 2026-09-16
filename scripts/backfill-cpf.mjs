/**
 * backfill-cpf.mjs
 *
 * Backfill retroativo do campo `cpf` em inscritos legados que estavam sem CPF
 * porque o worker/sync-shopify.mjs só liam o metafield custom.cpf do cliente
 * (praticamente nunca preenchido) em vez do note_attribute `cpf_cliente` do
 * checkout, que é onde o CPF de fato é gravado (fix aplicado em
 * workers/shopify-webhook/src/index.js e scripts/sync-shopify.mjs).
 *
 * Este script cobre só os pedidos onde o CPF é RECUPERÁVEL: o campo
 * `cpf_cliente` só existe em note_attributes a partir de ~SPFY21000 (quando
 * o checkout ganhou esse campo) — pedidos mais antigos nunca tiveram esse
 * dado coletado, então "CPF não informado" neles está correto e não é bug.
 *
 * Dados coletados manualmente via MCP Shopify (graphql_query, orders +
 * customAttributes) em 2026-09-10, cruzando com os 795 inscritos sem CPF
 * no Firestore. Não chama a Shopify — os pares pedido→CPF já estão embutidos.
 *
 * Idempotente: só grava em inscritos que ainda não têm `cpf` no momento da
 * execução (revalida no próprio script, não confia em snapshot antigo).
 * Não altera nenhum outro campo.
 *
 * Uso:
 *   node scripts/backfill-cpf.mjs           # dry-run
 *   node scripts/backfill-cpf.mjs --apply   # grava de fato
 */

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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

// pedido (order name) -> cpf, coletado via note_attributes.cpf_cliente
const CPF_POR_PEDIDO = {
  SPFY22505: '26961592899', SPFY22507: '37391477842', SPFY22518: '01242370617',
  SPFY22519: '19674083863', SPFY22520: '38125812806', SPFY22535: '32695320833',
  SPFY22536: '40286157802', SPFY22546: '47602149840', SPFY22550: '46032067807',
  SPFY22561: '46828308808', SPFY22578: '39567101850', SPFY22601: '13489564880',
  SPFY22661: '32493004892', SPFY22709: '43626839842', SPFY22711: '86510074508',
  SPFY22713: '42546973843', SPFY22724: '14244051813', SPFY22725: '29102113805',
  SPFY22789: '01425387608', SPFY22811: '35331575803', SPFY22862: '31969226854',
  SPFY22925: '11644653680', SPFY22977: '12346591823', SPFY23072: '36626092820',
  SPFY23263: '02817341864',
  SPFY22220: '04313423001', SPFY22506: '11801489912', SPFY22526: '40579906825',
  SPFY22530: '35833321808', SPFY22575: '52505974837', SPFY22621: '22550205804',
  SPFY22640: '25459218829', SPFY22832: '04399934905', SPFY22860: '85409790987',
  SPFY22883: '07328420936', SPFY22884: '07617069928', SPFY22902: '38696948823',
  SPFY22916: '45920070854', SPFY22971: '27599049894', SPFY23037: '00531489914',
  SPFY23062: '30459244841', SPFY23163: '93627467949', SPFY23167: '05380610900',
  SPFY23171: '05618335913', SPFY23172: '12064059962', SPFY23180: '06117237944',
  SPFY23184: '06117237944',
  SPFY23082: '46567076860', SPFY23089: '45942172811', SPFY23109: '43626839842',
  SPFY23117: '40716453851', SPFY23128: '38645466805', SPFY23129: '03839719500',
  SPFY23174: '03610061448', SPFY23198: '47917084825', SPFY23211: '45151165844',
  SPFY23255: '32004763892', SPFY23260: '31204850801',
};

async function backfill() {
  console.log('=== Backfill de CPF (note_attributes.cpf_cliente) ===');
  console.log(`Modo: ${APPLY ? 'APLICAR (grava no Firestore)' : 'DRY-RUN (nenhuma gravação)'}`);
  const pedidos = Object.keys(CPF_POR_PEDIDO);
  console.log(`Pedidos com CPF recuperado: ${pedidos.length}\n`);

  // Busca só os docs desses pedidos específicos (where...in, lotes de 30) —
  // muito mais barato que escanear a coleção inteira (quota do Firestore
  // andou apertada nesta conta).
  let jaTinhaCpf = 0;
  const pendentesGravar = [];
  const encontrados = new Set();

  const CHUNK = 30;
  for (let i = 0; i < pedidos.length; i += CHUNK) {
    const chunk = pedidos.slice(i, i + CHUNK);
    const snap = await db.collectionGroup('inscritos').where('pedido', 'in', chunk).get();
    for (const doc of snap.docs) {
      const data = doc.data();
      encontrados.add(data.pedido);
      if (data.cpf) {
        jaTinhaCpf++;
        continue; // já preenchido (por sync manual ou outro processo) — não sobrescreve
      }
      pendentesGravar.push({ ref: doc.ref, pedido: data.pedido, cpf: CPF_POR_PEDIDO[data.pedido] });
    }
  }

  const naoEncontrados = pedidos.filter(p => !encontrados.has(p));
  if (naoEncontrados.length) {
    console.log(`AVISO: ${naoEncontrados.length} pedido(s) não encontrado(s) no Firestore: ${naoEncontrados.join(', ')}`);
  }

  console.log(`Já tinham CPF (pulados): ${jaTinhaCpf}`);
  console.log(`Serão gravados: ${pendentesGravar.length}\n`);

  for (const { pedido, cpf, ref } of pendentesGravar) {
    console.log(`  + ${APPLY ? 'gravando' : '(dry-run) gravaria'}: ${pedido} -> cpf=${cpf} (${ref.path})`);
    if (APPLY) {
      await ref.update({ cpf });
      gravados++;
    }
  }

  console.log(`\n=== Resumo ===`);
  console.log(`Já tinham CPF:     ${jaTinhaCpf}`);
  console.log(`${APPLY ? 'Gravados' : 'Gravaria'}:  ${APPLY ? gravados : pendentesGravar.length}`);

  if (!APPLY) {
    console.log('\n[DRY-RUN] Nenhuma alteração foi gravada. Execute com --apply para gravar.\n');
  } else {
    console.log('\n=== Backfill concluído ===\n');
  }
}

backfill().catch(err => {
  console.error('\nErro fatal no backfill:', err.message || err);
  process.exit(1);
});
