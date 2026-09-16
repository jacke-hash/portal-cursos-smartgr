/**
 * backfill-pedidos-ausentes.mjs
 *
 * Backfill pontual dos pedidos pagos que ficaram sem inscrito no Firestore por causa da
 * falha na integração Shopify -> Cloudflare Worker iniciada em 2026-08-21 ~12:04 UTC
 * (último pedido sincronizado com sucesso: SPFY22220, às 11:58:27 UTC do mesmo dia).
 *
 * Os 18 pedidos abaixo foram identificados manualmente (via MCP Shopify + varredura do
 * Firestore) como pagos na Shopify e ausentes na subcoleção `inscritos` correspondente.
 * Os dados de cada pedido (cliente, endereço, desconto, CPF do checkout, afiliado) foram
 * coletados via API da Shopify e estão embutidos abaixo — este script NÃO chama a API da
 * Shopify (o token local do .env está criptografado via dotenvx e não decodifica aqui).
 *
 * Replica a mesma lógica de gravação do worker (workers/shopify-webhook/src/index.js
 * processOrder/recalcEvento/recalcCurso) para os inscritos ficarem idênticos aos criados
 * pelo fluxo normal. Não corrige a causa raiz da falha — só repõe os dados que já deveriam
 * existir. Depois de rodar, os pedidos ausentes precisam sair da lista de monitoramento da
 * reconciliação diária (scripts/reconciliacao-pedidos.mjs) automaticamente, já que passam a
 * existir no Firestore.
 *
 * Uso:
 *   node scripts/backfill-pedidos-ausentes.mjs           # dry-run: só mostra o que seria gravado
 *   node scripts/backfill-pedidos-ausentes.mjs --apply   # grava de fato
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

// ── Dados coletados via MCP Shopify (graphql_query + get-order) em 2026-08-25 ──────────────
// cpf vem do custom attribute "cpf_cliente" do checkout (mesmo valor que normalmente vai
// pro metafield custom.cpf do cliente, que o worker consulta via getCustomerCpf).
const PEDIDOS = [
  {
    orderId: '6658683043997', orderName: 'SPFY22222', productId: '8695759601821',
    variantId: '47883786846365', varianteTitle: '23/08/2026  - Porto Alegre - RS (TECH)',
    precoCatalogo: 299.0, descontoOrdem: 299.0, createdAt: '2026-08-21T12:04:57Z',
    cliente: 'JULIANA OLIVEIRA', email: 'sanolijuliana@gmail.com', telefone: '+5551991355899',
    cidade: 'Porto Alegre', estado: 'Rio Grande do Sul', empresa: '', vendedor: '',
    cpf: '01136397098',
  },
  {
    orderId: '6658740387997', orderName: 'SPFY22231', productId: '8695759601821',
    variantId: '47883786846365', varianteTitle: '23/08/2026  - Porto Alegre - RS (TECH)',
    precoCatalogo: 299.0, descontoOrdem: 29.9, createdAt: '2026-08-21T13:08:02Z',
    cliente: 'Márcia Machado', email: 'dra.marciamachadofarma@hotmail.com', telefone: '51996345424',
    cidade: 'Porto Alegre', estado: 'Rio Grande do Sul', empresa: '', vendedor: 'Wendy Soares',
    cpf: '81957840030',
  },
  {
    orderId: '6658768601245', orderName: 'SPFY22233', productId: '8680458551453',
    variantId: '48776225489053', varianteTitle: '31/08/2026 - São Paulo (Zona Sul)',
    precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-21T13:36:15Z',
    cliente: 'CRISTINA MARIA MINERVINI', email: 'ricsmc333@gmail.com', telefone: '+5511999739193',
    cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: 'Ligia Carbone',
    cpf: '35617110144',
  },
  {
    orderId: '6658774139037', orderName: 'SPFY22234', productId: '8695759601821',
    variantId: '47883786846365', varianteTitle: '23/08/2026  - Porto Alegre - RS (TECH)',
    precoCatalogo: 299.0, descontoOrdem: 299.0, createdAt: '2026-08-21T13:40:33Z',
    cliente: 'Maurício Friederich', email: 'friederich2050@gmail.com', telefone: '51999769955',
    cidade: 'Porto Alegre', estado: 'Rio Grande do Sul', empresa: '', vendedor: 'Wendy Soares',
    cpf: '00894804065',
  },
  {
    orderId: '6659013017757', orderName: 'SPFY22254', productId: '8695759601821',
    variantId: '47883786846365', varianteTitle: '23/08/2026  - Porto Alegre - RS (TECH)',
    precoCatalogo: 299.0, descontoOrdem: 14.95, createdAt: '2026-08-21T16:48:38Z',
    cliente: 'Milene Dorneles', email: 'milene_dorneles@hotmail.com', telefone: '51993439696',
    cidade: 'Cachoeirinha', estado: 'Rio Grande do Sul', empresa: '', vendedor: '',
    cpf: '03283717001',
  },
  {
    orderId: '6659020980381', orderName: 'SPFY22257', productId: '8680458551453',
    variantId: '48776225489053', varianteTitle: '31/08/2026 - São Paulo (Zona Sul)',
    precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-21T16:55:20Z',
    cliente: 'Tatiana Ciszewski', email: 'tatiana.ciszewski@gmail.com', telefone: '11981798531',
    cidade: 'Guarulhos', estado: 'São Paulo', empresa: '', vendedor: 'Ligia Carbone',
    cpf: '27671044814',
  },
  {
    orderId: '6659022913693', orderName: 'SPFY22259', productId: '8695759601821',
    variantId: '47883786846365', varianteTitle: '23/08/2026  - Porto Alegre - RS (TECH)',
    precoCatalogo: 299.0, descontoOrdem: 299.0, createdAt: '2026-08-21T16:56:26Z',
    cliente: 'Silvia Garcia', email: 'silviagdesigner@gmail.com', telefone: '51991877782',
    cidade: 'Alvorada', estado: 'Rio Grande do Sul', empresa: '', vendedor: 'Daiane Benedix',
    cpf: '97661171015',
  },
  {
    orderId: '6659869966493', orderName: 'SPFY22285', productId: '8695759601821',
    variantId: '47883786846365', varianteTitle: '23/08/2026  - Porto Alegre - RS (TECH)',
    precoCatalogo: 299.0, descontoOrdem: 299.0, createdAt: '2026-08-21T20:29:01Z',
    cliente: 'Daniela Lumertz Reck', email: 'danyreck@terra.com.br', telefone: '51998669693',
    cidade: 'Porto Alegre', estado: 'Rio Grande do Sul', empresa: '', vendedor: '',
    cpf: '66126355091',
  },
  {
    orderId: '6659884679325', orderName: 'SPFY22286', productId: '8695759601821',
    variantId: '47883786846365', varianteTitle: '23/08/2026  - Porto Alegre - RS (TECH)',
    precoCatalogo: 299.0, descontoOrdem: 299.0, createdAt: '2026-08-21T20:40:38Z',
    cliente: 'VANESSA SILVA DA SILVA', email: 'atendimento@dedesteticaesaude.com.br', telefone: '+5551991622617',
    cidade: 'Alvorada', estado: 'Rio Grande do Sul', empresa: '', vendedor: '',
    cpf: '86220390059',
  },
  {
    orderId: '6660010639517', orderName: 'SPFY22294', productId: '8695759601821',
    variantId: '48311725883549', varianteTitle: '18/10/2026 - Balneário Camboriú - SC',
    precoCatalogo: 299.0, descontoOrdem: 44.85, createdAt: '2026-08-21T22:27:10Z',
    cliente: 'Pâmela PROBST STOCK', email: 'pamelaprobststock@gmail.com', telefone: '+5547991949196',
    cidade: 'AURORA', estado: 'Santa Catarina', empresa: '', vendedor: 'GORETI SHOPPING DA ESTETICA LTDA',
    cpf: '00759893950',
  },
  {
    orderId: '6660202299549', orderName: 'SPFY22302', productId: '8695759601821',
    variantId: '47883786846365', varianteTitle: '23/08/2026  - Porto Alegre - RS (TECH)',
    precoCatalogo: 299.0, descontoOrdem: 29.9, createdAt: '2026-08-22T01:40:06Z',
    cliente: 'Bianca Maestri', email: 'bimaestridesigner@gmail.com', telefone: '51985809564',
    cidade: 'Gravataí', estado: 'Rio Grande do Sul', empresa: '', vendedor: 'Wendy Soares',
    cpf: '86559176053',
  },
  {
    orderId: '6661006393501', orderName: 'SPFY22313', productId: '8695759601821',
    variantId: '47883786846365', varianteTitle: '23/08/2026  - Porto Alegre - RS (TECH)',
    precoCatalogo: 299.0, descontoOrdem: 14.95, createdAt: '2026-08-22T17:14:22Z',
    cliente: 'Laika Koch', email: 'laikaheloysa@gmail.com', telefone: '51998414528',
    cidade: 'Novo Hamburgo', estado: 'Rio Grande do Sul', empresa: '', vendedor: 'Giovanna Barreto',
    cpf: '01695597001',
  },
  {
    orderId: '6661476515997', orderName: 'SPFY22330', productId: '8695759601821',
    variantId: '47883786846365', varianteTitle: '23/08/2026  - Porto Alegre - RS (TECH)',
    precoCatalogo: 299.0, descontoOrdem: 299.0, createdAt: '2026-08-23T01:01:37Z',
    cliente: 'Maiara Leal', email: 'maiaragarcia2021@gmail.com', telefone: '51982474696',
    cidade: 'Canoas', estado: 'Rio Grande do Sul', empresa: '', vendedor: '',
    cpf: '02703959075',
  },
  {
    orderId: '6662113919133', orderName: 'SPFY22343', productId: '8928830193821',
    variantId: '48396371624093', varianteTitle: 'Setor Rosa',
    precoCatalogo: 224.0, descontoOrdem: 0.0, createdAt: '2026-08-23T14:12:54Z',
    cliente: 'Dayanne Magalhaes', email: 'dayanne1982@live.com', telefone: '11922327232',
    cidade: 'São Paulo', estado: 'São Paulo', empresa: '', vendedor: '',
    cpf: '05112768690',
  },
  {
    orderId: '6662145310877', orderName: 'SPFY22345', productId: '8928830193821',
    variantId: '48396371624093', varianteTitle: 'Setor Rosa',
    precoCatalogo: 224.0, descontoOrdem: 0.0, createdAt: '2026-08-23T14:43:50Z',
    cliente: 'Alexandre Pires Correia', email: 'acorr2001@gmail.com', telefone: '11982625271',
    cidade: 'Osasco', estado: 'São Paulo', empresa: '', vendedor: '',
    cpf: '18711985852',
  },
  {
    orderId: '6662696730781', orderName: 'SPFY22354', productId: '8680458551453',
    variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)',
    precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-23T22:51:59Z',
    cliente: 'Silvian Cunha de Oliveira Silva', email: 'silviancunhaoliveira@hotmail.com', telefone: '21988301958',
    cidade: 'Rio de Janeiro', estado: 'Rio de Janeiro', empresa: '', vendedor: '',
    cpf: '05476079700',
  },
  {
    orderId: '6662698238109', orderName: 'SPFY22355', productId: '8680458551453',
    variantId: '48827073790109', varianteTitle: '02/09/2026 - São Paulo (Zona Sul)',
    precoCatalogo: 1290.0, descontoOrdem: 1290.0, createdAt: '2026-08-23T22:53:43Z',
    cliente: 'Kevelyn Da Silva', email: 'nutri.kevelynsilva@gmail.com', telefone: '21993970204',
    cidade: 'Rio de Janeiro', estado: 'Rio de Janeiro', empresa: '', vendedor: '',
    cpf: '12603095765',
  },
  {
    orderId: '6663433814173', orderName: 'SPFY22373', productId: '8695759601821',
    variantId: '48311725883549', varianteTitle: '18/10/2026 - Balneário Camboriú - SC',
    precoCatalogo: 299.0, descontoOrdem: 299.0, createdAt: '2026-08-24T13:31:36Z',
    cliente: 'Sonara Albino', email: 'dra.sonara@gmail.com', telefone: '47999457771',
    cidade: 'Rio do sul', estado: 'Santa Catarina', empresa: '', vendedor: '',
    cpf: '07604533906',
  },
];

// Mesmo parser de workers/shopify-webhook/src/index.js — mantém a mesma regra de data.
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
  console.log('=== Backfill de pedidos ausentes (falha de integração 2026-08-21) ===');
  console.log(`Modo: ${APPLY ? 'APLICAR (grava no Firestore)' : 'DRY-RUN (nenhuma gravação)'}`);
  console.log(`Total de pedidos no lote: ${PEDIDOS.length}\n`);

  const afetados = new Map(); // "productId:variantId" -> { productId, variantId, varianteTitle }
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

    const quantidade = 1;
    const subtotal = p.precoCatalogo * quantidade;
    const descontoAplicado = Math.min(p.descontoOrdem, subtotal);
    const valorFinalPago = Math.max(0, subtotal - descontoAplicado);
    const valorUnitarioPago = valorFinalPago / quantidade;
    const now = Timestamp.now();

    const doc = {
      pedido: p.orderName, shopifyId: p.orderId,
      productId: p.productId, variantId: p.variantId, variante: p.varianteTitle,
      quantidade, precoCatalogo: p.precoCatalogo, descontoAplicado, valorFinalPago, valorUnitarioPago,
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

// Mesma regra de "inscrito ativo" do worker e do restante do projeto.
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
