/**
 * backfill-pedidos-ausentes-lote2.mjs
 *
 * Segundo lote do backfill iniciado em scripts/backfill-pedidos-ausentes.mjs. A falha de
 * integração Shopify -> Cloudflare Worker (início 2026-08-21 ~12:04 UTC, ainda não corrigida
 * na raiz) continuou gerando pedidos pagos sem inscrito no Firestore depois do primeiro lote
 * (18 pedidos, rodado em 2026-08-25). Este lote cobre os 30 pedidos que se acumularam entre
 * 2026-08-24 15:15 UTC e 2026-08-25 19:48 UTC, identificados via MCP Shopify + varredura do
 * Firestore (todos confirmados AUSENTES antes de rodar este script).
 *
 * Mesma lógica do lote 1 (mirror de processOrder/recalcEvento/recalcCurso do worker). Não
 * corrige a causa raiz — só repõe dados que já deveriam existir. A causa raiz continua sem
 * diagnóstico confirmado (precisa checar Shopify Notifications > Webhooks + logs do Cloudflare
 * Worker) — sem isso, um lote 3, 4, 5... vai continuar sendo necessário.
 *
 * Uso:
 *   node scripts/backfill-pedidos-ausentes-lote2.mjs           # dry-run
 *   node scripts/backfill-pedidos-ausentes-lote2.mjs --apply   # grava de fato
 */

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

// ── Dados coletados via MCP Shopify (graphql_query) em 2026-08-25 ──────────────────────────
const PEDIDOS = [
  { orderId: '6663563411613', orderName: 'SPFY22381', productId: '8680458551453', variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-24T15:15:20Z', cliente: 'Maria Rejane Alves', email: 'rejane_caio@hotmail.com', telefone: '11992486017', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Gabriela Silva', cpf: '30975616846' },
  { orderId: '6663569965213', orderName: 'SPFY22382', productId: '8680458551453', variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-24T15:19:46Z', cliente: 'Thayse Barros', email: 'biomed_nutri@hotmail.com', telefone: '11915953110', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Gabriela Silva', cpf: '27293526865' },
  { orderId: '6663604994205', orderName: 'SPFY22387', productId: '8680458551453', variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-24T15:52:08Z', cliente: 'Claudia edith cezar mazzucatto', email: 'claudiamazzucatto@gmail.com', telefone: '11948395683', cidade: 'Barueri', estado: 'São Paulo', empresa: '', vendedor: 'Gabriela Silva', cpf: '10660705800' },
  { orderId: '6663631700125', orderName: 'SPFY22390', productId: '8695759601821', variantId: '48311725883549', varianteTitle: '18/10/2026 - Balneário Camboriú - SC', quantidade: 1, precoCatalogo: 299.0, descontoOrdem: 0.0, createdAt: '2026-08-24T16:13:35Z', cliente: 'Tamires Azevedo', email: 'espacotamiresazevedo@gmail.com', telefone: '51981889299', cidade: 'Porto Alegre', estado: 'Rio Grande do Sul', empresa: '', vendedor: '', cpf: '03839146046' },
  { orderId: '6663643594909', orderName: 'SPFY22392', productId: '8928830193821', variantId: '48396371624093', varianteTitle: 'Setor Rosa', quantidade: 1, precoCatalogo: 224.0, descontoOrdem: 0.0, createdAt: '2026-08-24T16:24:35Z', cliente: 'Tamires Azeveod', email: 'espacotamiresazevedo@gmail.com', telefone: '+5551981889299', cidade: 'Porto Alegre', estado: 'Rio Grande do Sul', empresa: '', vendedor: '', cpf: '03839146046' },
  { orderId: '6663679082653', orderName: 'SPFY22396', productId: '8695759601821', variantId: '48319293915293', varianteTitle: '20/09/2026 - Campinas - SP', quantidade: 1, precoCatalogo: 299.0, descontoOrdem: 0.0, createdAt: '2026-08-24T16:54:56Z', cliente: 'Rodrigo Lima', email: 'rodrigolima06091983@gmail.com', telefone: '+5519991756994', cidade: 'Campinas', estado: 'São Paulo', empresa: '', vendedor: 'Loja Campinas', cpf: '22116824800' },
  { orderId: '6663726989469', orderName: 'SPFY22398', productId: '8695759601821', variantId: '48311725883549', varianteTitle: '18/10/2026 - Balneário Camboriú - SC', quantidade: 1, precoCatalogo: 299.0, descontoOrdem: 44.85, createdAt: '2026-08-24T17:31:42Z', cliente: 'Juliana Moratelli', email: 'moratellijuh73@gmail.com', telefone: '47984141572', cidade: 'Rio do Sul', estado: 'Santa Catarina', empresa: '', vendedor: 'GORETI SHOPPING DA ESTETICA LTDA', cpf: '90317408968' },
  { orderId: '6663766081693', orderName: 'SPFY22403', productId: '8680458551453', variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-24T18:02:01Z', cliente: 'Danielle Silva de moraes', email: 'danimoosil@gmail.com', telefone: '11975098386', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Alane Alves', cpf: '42516011814' },
  { orderId: '6663792951453', orderName: 'SPFY22410', productId: '8680458551453', variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-24T18:24:29Z', cliente: 'Renata Mitie Iwakura', email: 'remitieiwakura@gmail.com', telefone: '11983112333', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Talita Anjos', cpf: '33835899864' },
  { orderId: '6663821787293', orderName: 'SPFY22412', productId: '8680458551453', variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-24T18:49:46Z', cliente: 'Jacqueline Roberto', email: 'jacquelineroberto@omacaresp.com', telefone: '11995313671', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Gabriela Tavares', cpf: '26480855809' },
  { orderId: '6663824179357', orderName: 'SPFY22413', productId: '8680458551453', variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-24T18:52:06Z', cliente: 'Gabriela Figueiredo Cavalcante', email: 'gcavalcante.biomedicina@gmail.com', telefone: '11952100625', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Ionara Batista', cpf: '45387858819' },
  { orderId: '6663825916061', orderName: 'SPFY22414', productId: '8680458551453', variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-24T18:54:01Z', cliente: 'Joice Meire Araújo Costa', email: 'drajoicemeire@gmail.com', telefone: '11962556066', cidade: 'Santo André', estado: 'São Paulo', empresa: '', vendedor: 'Gabriela Silva', cpf: '14037914816' },
  { orderId: '6663843020957', orderName: 'SPFY22416', productId: '8680458551453', variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-24T19:09:22Z', cliente: 'Adriana Lobo', email: 'a3_lobo@hotmail.com', telefone: '11950455629', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Gabriela Tavares', cpf: '11826957871' },
  { orderId: '6663858618525', orderName: 'SPFY22419', productId: '8680458551453', variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-24T19:24:57Z', cliente: 'Marcela Oliveira', email: 'marcela.cubs@gmail.com', telefone: '11963723114', cidade: 'Biritiba-Mirim', estado: 'São Paulo', empresa: '', vendedor: 'Beatriz Oliveira', cpf: '45708462892' },
  { orderId: '6663899938973', orderName: 'SPFY22421', productId: '8680458551453', variantId: '48785631772829', varianteTitle: '22/10/2026 - Rio Claro', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-24T19:43:30Z', cliente: 'Thaís Albiero', email: 'thaisaalbiero@gmail.com', telefone: '15998257578', cidade: 'Porto feliz', estado: 'São Paulo', empresa: '', vendedor: 'Laryssa Amaral', cpf: '49831212851' },
  { orderId: '6663911702685', orderName: 'SPFY22425', productId: '8695759601821', variantId: '48311725883549', varianteTitle: '18/10/2026 - Balneário Camboriú - SC', quantidade: 1, precoCatalogo: 299.0, descontoOrdem: 44.85, createdAt: '2026-08-24T19:54:15Z', cliente: 'Gleici Selinger Schlickmann', email: 'gleice.selinger13@gmail.com', telefone: '+5547999903771', cidade: 'Salete', estado: 'Santa Catarina', empresa: '', vendedor: 'GORETI SHOPPING DA ESTETICA LTDA', cpf: '10290934907' },
  { orderId: '6664970600605', orderName: 'SPFY22465', productId: '8695759601821', variantId: '48311725883549', varianteTitle: '18/10/2026 - Balneário Camboriú - SC', quantidade: 1, precoCatalogo: 299.0, descontoOrdem: 0.0, createdAt: '2026-08-25T15:31:13Z', cliente: 'Jaqueline Jung', email: 'jackemjung@gmail.com', telefone: '47991810956', cidade: 'Jaraguá do Sul', estado: 'Santa Catarina', empresa: '', vendedor: 'GORETI SHOPPING DA ESTETICA LTDA', cpf: '07626941900' },
  { orderId: '6665319940253', orderName: 'SPFY22477', productId: '8680458551453', variantId: '48839442497693', varianteTitle: '14/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T18:13:30Z', cliente: 'Maria Eduarda Vieira', email: 'contato@dranalumurad.com', telefone: '11941760646', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Gabriela Tavares', cpf: '51644133881' },
  { orderId: '6665325314205', orderName: 'SPFY22479', productId: '8680458551453', variantId: '48839442497693', varianteTitle: '14/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T18:18:08Z', cliente: 'Lara Goss', email: 'laragoss@hotmail.com', telefone: '11979700854', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Ionara Batista', cpf: '52675063894' },
  { orderId: '6665333309597', orderName: 'SPFY22483', productId: '8680458551453', variantId: '48839442530461', varianteTitle: '21/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T18:24:14Z', cliente: 'Lucineia Camargo', email: 'lucineiacamargo.18@gmail.com', telefone: '11972757647', cidade: 'Mauá', estado: 'São Paulo', empresa: '', vendedor: 'Camila Silva', cpf: '19269963802' },
  { orderId: '6665333440669', orderName: 'SPFY22484', productId: '8680458551453', variantId: '48839442497693', varianteTitle: '14/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T18:24:18Z', cliente: 'Tatiana Bezerra de Araújo Galves', email: 'tatiagalves@gmail.com', telefone: '11981870883', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Ionara Batista', cpf: '31217253866' },
  { orderId: '6665334554781', orderName: 'SPFY22485', productId: '8680458551453', variantId: '48839442530461', varianteTitle: '21/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T18:25:06Z', cliente: 'Sara Ramos', email: 'espacosararamos@gmail.com', telefone: '11939551200', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Camila Silva', cpf: '50014561859' },
  { orderId: '6665337176221', orderName: 'SPFY22486', productId: '8680458551453', variantId: '48839442530461', varianteTitle: '21/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T18:27:00Z', cliente: 'Rawan Braga', email: 'rawanbraga@gmail.com', telefone: '11954985559', cidade: 'São Bernardo do Campo', estado: 'São Paulo', empresa: '', vendedor: 'Thais Aragão', cpf: '24194092805' },
  { orderId: '6665338650781', orderName: 'SPFY22487', productId: '8680458551453', variantId: '48839442497693', varianteTitle: '14/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T18:27:59Z', cliente: 'Monique Berger de Oliveira', email: 'mbergedeoliveira@gmail.com', telefone: '11981636585', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Ionara Batista', cpf: '19995546809' },
  { orderId: '6665343271069', orderName: 'SPFY22489', productId: '8680458551453', variantId: '48839442497693', varianteTitle: '14/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T18:31:43Z', cliente: 'Fernanda Martha Silos', email: 'fer_martha@hotmail.com', telefone: '11950789966', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Talita Anjos', cpf: '34423394804' },
  { orderId: '6665348022429', orderName: 'SPFY22490', productId: '8680458551453', variantId: '48839442530461', varianteTitle: '21/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T18:33:47Z', cliente: 'Luisa Ossani', email: 'luisaossanij@gmail.com', telefone: '35999707333', cidade: 'Varginha', estado: 'Minas Gerais', empresa: '', vendedor: 'Talita Anjos', cpf: '02009746619' },
  { orderId: '6665363914909', orderName: 'SPFY22493', productId: '8680458551453', variantId: '48839442497693', varianteTitle: '14/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T18:39:41Z', cliente: 'MARCELE RICCI', email: 'marcelericci@gmail.com', telefone: '11967527226', cidade: 'São Bernardo do Campo', estado: 'São Paulo', empresa: '', vendedor: 'Ionara Batista', cpf: '28843089897' },
  { orderId: '6665364963485', orderName: 'SPFY22494', productId: '8680458551453', variantId: '48839442530461', varianteTitle: '21/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T18:40:24Z', cliente: 'Thamyris Sousa Pereira', email: 'thamyris.sousa98@hotmail.com', telefone: '11964624749', cidade: 'Carapicuíba', estado: 'São Paulo', empresa: '', vendedor: 'Thais Aragão', cpf: '38871334809' },
  { orderId: '6665413853341', orderName: 'SPFY22496', productId: '8680458551453', variantId: '48839442497693', varianteTitle: '14/09/2026 - São Paulo (Zona Sul)', quantidade: 1, precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-25T19:19:47Z', cliente: 'Shirley Gil de Oliveira Romero', email: 'shirleygilromero@gmail.com', telefone: '+5511996917942', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Ionara Batista', cpf: '30211817830' },
  { orderId: '6665446916253', orderName: 'SPFY22502', productId: '8680458551453', variantId: '48839442497693', varianteTitle: '14/09/2026 - São Paulo (Zona Sul)', quantidade: 2, precoCatalogo: 1290.0, descontoOrdem: 2580.0, createdAt: '2026-08-25T19:48:02Z', cliente: 'Vitor Romero', email: 'vitorleiteromero@gmail.com', telefone: '11996575999', cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: '', cpf: '28432672858' },
];

function parseVariantTitle(title) {
  if (!title || typeof title !== 'string') return null;
  const idx = title.indexOf(' - ');
  if (idx === -1) return { date: null, local: title.trim() };
  const datePart = title.slice(0, idx).trim();
  const local = title.slice(idx + 3).trim();
  const segments = datePart.split('/');
  if (segments.length !== 3) return { date: null, local: title.trim() };
  const [day, month, year] = segments;
  const date = new Date(`${year}-${month}-${day}T12:00:00.000Z`);
  if (isNaN(date.getTime())) return { date: null, local: title.trim() };
  return { date, local };
}

async function backfill() {
  console.log('=== Backfill de pedidos ausentes — lote 2 ===');
  console.log(`Modo: ${APPLY ? 'APLICAR (grava no Firestore)' : 'DRY-RUN (nenhuma gravação)'}`);
  console.log(`Total de pedidos no lote: ${PEDIDOS.length}\n`);

  const afetados = new Map();
  const cursosAfetados = new Set();
  let jaExistiam = 0;
  let novos = 0;

  for (const p of PEDIDOS) {
    const inscritoId = `${p.orderId}-${p.variantId}`;
    const path = `cursos/${p.productId}/eventos/${p.variantId}/inscritos/${inscritoId}`;
    const ref = db.doc(path);
    const existing = await ref.get();

    if (existing.exists) {
      jaExistiam++;
      console.log(`  = já existe, pulando: ${p.orderName} (${path})`);
      continue;
    }

    const subtotal = p.precoCatalogo * p.quantidade;
    const descontoAplicado = Math.min(p.descontoOrdem, subtotal);
    const valorFinalPago = Math.max(0, subtotal - descontoAplicado);
    const valorUnitarioPago = valorFinalPago / p.quantidade;
    const now = Timestamp.now();

    const doc = {
      pedido: p.orderName, shopifyId: p.orderId,
      productId: p.productId, variantId: p.variantId, variante: p.varianteTitle,
      quantidade: p.quantidade, precoCatalogo: p.precoCatalogo, descontoAplicado, valorFinalPago, valorUnitarioPago,
      valor: valorFinalPago,
      dataCompra: Timestamp.fromDate(new Date(p.createdAt)),
      cliente: p.cliente, email: p.email, telefone: p.telefone,
      cidade: p.cidade, estado: p.estado, empresa: p.empresa, vendedor: p.vendedor,
      cpf: p.cpf,
      financialStatus: 'paid',
      status: 'Não Confirmado',
      financialStatusUpdatedAt: now,
      observacao: '',
      impresso: false, impressoEm: null, impressoPor: null,
      createdAt: now, updatedAt: now,
    };

    console.log(`  + ${APPLY ? 'gravando' : '(dry-run) gravaria'}: ${p.orderName} -> ${path} | R$ ${valorFinalPago.toFixed(2)} | ${p.cliente}`);
    if (APPLY) await ref.set(doc);
    novos++;

    afetados.set(`${p.productId}:${p.variantId}`, { productId: p.productId, variantId: p.variantId, varianteTitle: p.varianteTitle, date: parseVariantTitle(p.varianteTitle)?.date || null });
    cursosAfetados.add(p.productId);
  }

  console.log(`\nNovos gravados: ${novos} | já existiam (pulados): ${jaExistiam}`);

  if (!APPLY) {
    console.log('\n[DRY-RUN] Nenhuma alteração foi gravada.');
    console.log('Execute com --apply para gravar e recalcular os agregados.\n');
    return;
  }

  console.log('\n=== Recalculando agregados dos eventos afetados ===');
  for (const { productId, variantId, varianteTitle, date } of afetados.values()) {
    const eventoRef = db.collection('cursos').doc(productId).collection('eventos').doc(variantId);
    const inscritosSnap = await eventoRef.collection('inscritos').get();
    const ativos = inscritosSnap.docs.map(d => d.data()).filter(isInscritoAtivo);
    const total = ativos.length;
    const confirmados = ativos.filter(i => i.status === 'Confirmado' || i.status === 'Presente').length;

    const exists = await eventoRef.get();
    if (exists.exists) {
      await eventoRef.update({ totalInscritos: total, confirmados, updatedAt: Timestamp.now() });
      console.log(`  evento ${productId}/${variantId} (${varianteTitle}): totalInscritos=${total} confirmados=${confirmados}`);
    } else {
      await eventoRef.set({
        varianteTitle, varianteId: variantId,
        data: date ? Timestamp.fromDate(date) : null,
        ativo: true, totalInscritos: total, confirmados, updatedAt: Timestamp.now(),
      });
      console.log(`  evento NOVO ${productId}/${variantId} (${varianteTitle}): totalInscritos=${total} confirmados=${confirmados}`);
    }
  }

  console.log('\n=== Recalculando agregados dos cursos afetados ===');
  for (const productId of cursosAfetados) {
    const cursoRef = db.collection('cursos').doc(productId);
    const eventosSnap = await cursoRef.collection('eventos').get();
    const eventos = eventosSnap.docs.map(d => d.data());
    const totalInscritos = eventos.reduce((s, e) => s + (e.totalInscritos || 0), 0);

    const agora = new Date();
    let proximoData = null, proximoEventoLabel = '';
    for (const ev of eventos) {
      const evDate = ev.data?.toDate?.() ?? null;
      if (evDate && evDate >= agora && (!proximoData || evDate < proximoData)) {
        proximoData = evDate;
        proximoEventoLabel = ev.varianteTitle || '';
      }
    }

    await cursoRef.update({
      totalInscritos, totalEventos: eventos.length, proximoEventoLabel, updatedAt: Timestamp.now(),
    });
    console.log(`  curso ${productId}: totalInscritos=${totalInscritos} totalEventos=${eventos.length} proximoEventoLabel="${proximoEventoLabel}"`);
  }

  console.log('\n=== Backfill concluído ===\n');
}

const INACTIVE_STATUS_LABELS = new Set([
  'Cancelado', 'Reembolsado', 'Parcialmente Reembolsado',
  'Expirado', 'Pendente', 'Autorizado', 'Anulado',
]);
function isInscritoAtivo(i) {
  if (i.financialStatus) return i.financialStatus === 'paid';
  return !INACTIVE_STATUS_LABELS.has(i.status);
}

backfill().catch(err => {
  console.error('\nErro fatal no backfill:', err.message || err);
  process.exit(1);
});
