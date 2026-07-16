import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// --- Caminhos ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ACCOUNT_PATH = join(__dirname, '..', 'service-account.json');

// --- Validações antecipadas (fail-fast) ---

if (!process.env.SHOPIFY_ACCESS_TOKEN) {
  console.error('SHOPIFY_ACCESS_TOKEN não encontrado no .env');
  process.exit(1);
}

if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('service-account.json não encontrado na raiz do projeto');
  process.exit(1);
}

// --- Catálogo de cursos: única fonte de verdade ---
// Chave: product_id Shopify (number). Valor: nome fallback (usado se a API não retornar o produto).

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
]);

const VALID_PRODUCT_IDS = new Set(KNOWN_COURSES.keys());

// IDs que devem obrigatoriamente existir na Shopify
const CRITICAL_IDS = [8695759601821, 8928830193821];

// Ignorar variantes com data anterior a 01/06/2026
const DATE_CUTOFF = new Date('2026-06-01T12:00:00.000Z');

// Statuses derivados da Shopify que indicam inscrito inativo (não pago)
const INACTIVE_STATUS_LABELS = new Set([
  'Cancelado', 'Reembolsado', 'Parcialmente Reembolsado',
  'Expirado', 'Pendente', 'Autorizado', 'Anulado',
]);

// Mapeia financial_status da Shopify → label operacional do portal
function shopifyStatusLabel(financialStatus, cancelledAt) {
  if (cancelledAt) return 'Cancelado';
  const map = {
    refunded:           'Reembolsado',
    partially_refunded: 'Parcialmente Reembolsado',
    pending:            'Pendente',
    authorized:         'Autorizado',
    expired:            'Expirado',
    voided:             'Anulado',
  };
  return map[financialStatus] ?? null;
}

// Retorna o financialStatus canônico: usa o campo se existe; faz fallback pelo status
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

// Verdadeiro se o inscrito é considerado ativo (pago)
function isAtivoData(data) {
  return resolveFinancialStatus(data) === 'paid';
}

// --- Shopify Config ---

const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'smart-gr-pro.myshopify.com';
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_BASE = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;

// --- Firebase Init ---

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// --- Helpers HTTP ---

function shopifyHeaders() {
  return {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json',
  };
}

async function shopifyGet(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let resp;
  try {
    resp = await fetch(url, { headers: shopifyHeaders(), signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timeout Shopify API (30s excedido)');
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Shopify API ${resp.status}: ${body}`);
  }
  return { data: await resp.json(), headers: resp.headers };
}

// Busca paginada genérica — retorna array de itens
async function fetchAllPages(firstUrl, extractItems) {
  const items = [];
  let url = firstUrl;

  while (url) {
    console.log(`  → GET ${url}`);
    const { data, headers } = await shopifyGet(url);
    const page = extractItems(data);
    items.push(...page);
    console.log(`    ${page.length} item(s) nesta página | total acumulado: ${items.length}`);

    const link = headers.get('Link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    url = match ? match[1] : null;
  }

  return items;
}

// --- Helpers de dados ---

// Parseia variante.
// Formato com data: "13/07/2026 - São Paulo (Zona Sul)" → { date: Date, local: string }
// Formato sem data: "Lote 1", "VIP", "Congressista"    → { date: null, local: string }
// Retorna null apenas se title for vazio ou não-string.
function parseVariantTitle(title) {
  if (!title || typeof title !== 'string') return null;

  const idx = title.indexOf(' - ');

  // Sem separador " - ": variante sem data (ex: "Lote 1", "VIP")
  if (idx === -1) {
    return { date: null, local: title.trim() };
  }

  const datePart = title.slice(0, idx).trim();
  const local = title.slice(idx + 3).trim();
  const segments = datePart.split('/');

  // Separador existe mas parte esquerda não é DD/MM/YYYY
  if (segments.length !== 3) {
    return { date: null, local: title.trim() };
  }

  const [day, month, year] = segments;
  const date = new Date(`${year}-${month}-${day}T12:00:00.000Z`);

  // Data inválida: tratar como variante sem data
  if (isNaN(date.getTime())) {
    return { date: null, local: title.trim() };
  }

  return { date, local };
}

function getCustomerName(order) {
  const first =
    order.billing_address?.first_name ||
    order.customer?.first_name ||
    order.shipping_address?.first_name || '';
  const last =
    order.billing_address?.last_name ||
    order.customer?.last_name ||
    order.shipping_address?.last_name || '';
  return `${first} ${last}`.trim();
}

function getPhone(order) {
  return (
    order.billing_address?.phone ||
    order.customer?.phone ||
    order.shipping_address?.phone || ''
  );
}

function isConfirmado(status) {
  return status === 'Confirmado' || status === 'Presente';
}

// Busca o metafield custom.cpf do cliente. Nunca lança erro — retorna '' em qualquer falha.
// Cache em memória evita buscar o mesmo cliente mais de uma vez por execução.
const cpfCache = new Map();
async function getCustomerCpf(customerId) {
  if (!customerId) return '';
  if (cpfCache.has(customerId)) return cpfCache.get(customerId);
  let cpf = '';
  try {
    const { data } = await shopifyGet(
      `${SHOPIFY_BASE}/customers/${customerId}/metafields.json?namespace=custom&key=cpf`
    );
    cpf = data.metafields?.[0]?.value || '';
  } catch (e) {
    console.log(`  Aviso: falha ao buscar CPF do cliente ${customerId}: ${e.message}`);
  }
  cpfCache.set(customerId, cpf);
  return cpf;
}

// Evento encerrado quando a data de calendário é <= hoje (inclui o próprio dia)
function isEventoEncerrado(date) {
  if (!date) return false;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const evDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return evDay <= hoje;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function sync() {
  console.log('=== Sincronização Shopify → Firestore ===');
  console.log(`Início: ${new Date().toISOString()}`);
  console.log('Shopify Token OK');
  console.log('Service Account OK');
  console.log('Firebase OK');
  console.log(`Cursos esperados: ${KNOWN_COURSES.size}\n`);

  // ─── FASE 1: Catálogo de produtos ─────────────────────────────────────────
  console.log('=== FASE 1: Catálogo de cursos ===');
  console.log('Buscando TODOS os produtos na Shopify...');

  const allProducts = await fetchAllPages(
    `${SHOPIFY_BASE}/products.json?limit=250&fields=id,title,status`,
    d => d.products || []
  );

  console.log(`\nTotal de produtos encontrados na Shopify: ${allProducts.length}`);

  // Indexar por id
  const shopifyProductMap = new Map();
  for (const p of allProducts) {
    shopifyProductMap.set(Number(p.id), p);
  }

  // Separar encontrados e ausentes
  const foundIds = [...VALID_PRODUCT_IDS].filter(id => shopifyProductMap.has(id));
  const missingIds = [...VALID_PRODUCT_IDS].filter(id => !shopifyProductMap.has(id));

  console.log(`\nIDs encontrados na Shopify (${foundIds.length}/${KNOWN_COURSES.size}):`);
  for (const id of foundIds) {
    const title = shopifyProductMap.get(id).title;
    console.log(`  ✓ ${id}: "${title}"`);
  }

  if (missingIds.length > 0) {
    console.log(`\nIDs ausentes na Shopify (${missingIds.length}):`);
    for (const id of missingIds) {
      console.log(`  ✗ ${id}: "${KNOWN_COURSES.get(id)}"`);
    }
  }

  // Validação de IDs críticos
  console.log('\nValidando IDs críticos...');
  for (const criticalId of CRITICAL_IDS) {
    if (shopifyProductMap.has(criticalId)) {
      console.log(`  ✓ ${criticalId} (${KNOWN_COURSES.get(criticalId)}): OK`);
    } else {
      console.error(`  ✗ ERRO CRÍTICO: ${criticalId} (${KNOWN_COURSES.get(criticalId)}) NÃO encontrado na Shopify`);
      console.error(`    Possíveis causas:`);
      console.error(`    1. Produto arquivado ou deletado na Shopify`);
      console.error(`    2. Token sem permissão para listas de produtos`);
      console.error(`    3. ID incorreto em KNOWN_COURSES`);
    }
  }

  // Criar/atualizar documento de curso para TODOS os 14 IDs
  console.log('\nGravando documentos de cursos no Firestore...');
  let cursosSincronizados = 0;

  for (const [productId, fallbackName] of KNOWN_COURSES) {
    const product = shopifyProductMap.get(productId);
    const nomeCurso = product?.title || fallbackName;
    const cursoRef = db.collection('cursos').doc(String(productId));

    try {
      await cursoRef.set(
        {
          nome: nomeCurso,
          shopifyProductId: String(productId),
          ativo: true,
          updatedAt: Timestamp.now(),
        },
        { merge: true }   // preserva totalInscritos e proximoEventoLabel existentes
      );

      const origem = product ? 'Shopify' : 'fallback';
      console.log(`  ✓ ${productId}: "${nomeCurso}" [${origem}]`);
      cursosSincronizados++;
    } catch (e) {
      console.error(`  ✗ Erro ao gravar curso ${productId}: ${e.message}`);
    }
  }

  // ─── FASE 2: Eventos das variantes Shopify ────────────────────────────────
  console.log('\n=== FASE 2: Eventos das variantes Shopify ===');

  let eventosCreated    = 0;
  let eventosUpdated    = 0;
  let eventosDesativados = 0;

  for (const [productId, fallbackName] of KNOWN_COURSES) {
    const nomeCurso = shopifyProductMap.get(productId)?.title || fallbackName;
    const cursoRef  = db.collection('cursos').doc(String(productId));

    console.log(`\n  ${nomeCurso} (${productId})`);

    // 1. Variantes atuais no Shopify
    let shopifyVariants = [];
    try {
      const { data: vData } = await shopifyGet(
        `${SHOPIFY_BASE}/products/${productId}/variants.json?limit=250`
      );
      shopifyVariants = vData.variants || [];
    } catch (e) {
      console.log(`    ⚠ Erro ao buscar variantes Shopify: ${e.message}`);
      continue;
    }

    // 2. Eventos existentes no Firestore para este produto
    let eventosFS = [];
    try {
      const snap = await cursoRef.collection('eventos').get();
      eventosFS = snap.docs.map(d => ({ ref: d.ref, id: d.id, ...d.data() }));
    } catch (e) {
      console.log(`    ⚠ Erro ao ler Firestore: ${e.message}`);
    }

    const shopifyVariantIds = new Set(shopifyVariants.map(v => String(v.id)));
    console.log(`    Variantes no Shopify : ${shopifyVariants.length}`);
    console.log(`    Eventos no Firestore : ${eventosFS.length}`);

    // 3. Criar/atualizar evento para cada variante do Shopify
    for (const variant of shopifyVariants) {
      const variantId    = String(variant.id);
      const variantTitle = variant.title || '';

      const parsed = parseVariantTitle(variantTitle);
      if (!parsed) {
        console.log(`    - ignorada (título inválido): "${variantTitle}"`);
        continue;
      }

      const { date } = parsed;

      // Corte de data: variante com data anterior ao cutoff não gera evento
      if (date !== null && date < DATE_CUTOFF) {
        console.log(`    - ignorada (data anterior ao corte): "${variantTitle}"`);
        continue;
      }

      const encerrado = isEventoEncerrado(date);
      const eventoRef = cursoRef.collection('eventos').doc(variantId);
      const jaExiste  = eventosFS.some(ev => ev.id === variantId);

      try {
        await eventoRef.set(
          {
            varianteTitle: variantTitle,
            varianteId:    variantId,
            data:          date ? Timestamp.fromDate(date) : null,
            ativo:         !encerrado,
            encerrado,
            updatedAt:     Timestamp.now(),
          },
          { merge: true }   // preserva totalInscritos/confirmados existentes
        );

        if (jaExiste) {
          eventosUpdated++;
          console.log(`    ✓ atualizado: "${variantTitle}"${encerrado ? ' [encerrado]' : ''}`);
        } else {
          eventosCreated++;
          console.log(`    + criado: "${variantTitle}"${encerrado ? ' [encerrado]' : ''}`);
        }
      } catch (e) {
        console.log(`    ✗ erro ao gravar evento ${variantId}: ${e.message}`);
      }
    }

    // 4. Desativar eventos órfãos (no Firestore mas ausentes no Shopify)
    const orfaos = eventosFS.filter(ev => !shopifyVariantIds.has(ev.id));
    if (orfaos.length) {
      console.log(`    Desativando ${orfaos.length} evento(s) órfão(s)...`);
    }
    for (const ev of orfaos) {
      try {
        await ev.ref.update({ ativo: false, encerrado: true, updatedAt: Timestamp.now() });
        eventosDesativados++;
        const dl = ev.data?.toDate?.()
          ?.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
          || 'sem data';
        console.log(`    ✗ desativado (órfão): [${dl}] "${ev.varianteTitle || ev.id}"`);
      } catch (e) {
        console.log(`    ✗ erro ao desativar ${ev.id}: ${e.message}`);
      }
    }
  }

  console.log(`\nEventos: ${eventosCreated} criados | ${eventosUpdated} atualizados | ${eventosDesativados} desativados`);

  // ─── FASE 3: Pedidos e inscritos ──────────────────────────────────────────
  console.log('\n=== FASE 3: Pedidos e inscritos ===');

  console.log('Buscando pedidos pagos...');
  const paidOrders = await fetchAllPages(
    `${SHOPIFY_BASE}/orders.json?financial_status=paid&status=any&limit=250`,
    d => d.orders || []
  );
  console.log(`Paid concluído: ${paidOrders.length} pedido(s)`);

  console.log('Buscando pedidos reembolsados...');
  const refundedOrders = await fetchAllPages(
    `${SHOPIFY_BASE}/orders.json?financial_status=refunded&status=any&limit=250`,
    d => d.orders || []
  );
  console.log(`Refunded concluído: ${refundedOrders.length} pedido(s)`);

  console.log('Buscando pedidos parcialmente reembolsados...');
  const partialRefundedOrders = await fetchAllPages(
    `${SHOPIFY_BASE}/orders.json?financial_status=partially_refunded&status=any&limit=250`,
    d => d.orders || []
  );
  console.log(`Partially refunded concluído: ${partialRefundedOrders.length} pedido(s)`);

  // Usa financial_status diretamente do objeto da Shopify (sem flag _isRefunded)
  const allOrders = [...paidOrders, ...refundedOrders, ...partialRefundedOrders];

  // Pedidos cancelados são processados pela reconciliação (Fase 6); aqui excluímos apenas
  // para não criar inscritos duplicados com dados de pedidos já cancelados nesta fase.
  const activeOrders = allOrders.filter(
    o => o.cancel_reason === null || o.cancel_reason === undefined
  );

  console.log(`\nTotal de pedidos: ${allOrders.length}`);
  console.log(`Pedidos sem cancelamento: ${activeOrders.length}`);

  let totalInscritos = 0;
  let inscritosIgnorados = 0;

  for (const order of activeOrders) {
    const orderFinancialStatus = order.financial_status || 'paid';
    const vendedor =
      order.note_attributes?.find(a => a.name === 'Affiliate')?.value || '';

    for (const item of order.line_items) {
      const productId = Number(item.product_id);
      if (!VALID_PRODUCT_IDS.has(productId)) continue;

      if (!item.variant_id) {
        console.log(`  Aviso: item sem variant_id. Pedido ${order.name}, produto ${productId}`);
        inscritosIgnorados++;
        continue;
      }

      const variantId = String(item.variant_id);
      const variantTitle = item.variant_title || '';

      if (!variantTitle) {
        console.log(`  Aviso: variante sem título. Pedido ${order.name}, produto ${productId}`);
        inscritosIgnorados++;
        continue;
      }

      const parsed = parseVariantTitle(variantTitle);
      if (!parsed) {
        // Só chega aqui se title for vazio/null — já validado acima
        inscritosIgnorados++;
        continue;
      }

      // Debug dedicado ao Congresso
      if (productId === 8928830193821) {
        console.log(
          `  [CONGRESSO] Pedido ${order.name} | Variante: "${variantTitle}"` +
          ` | Qty: ${item.quantity} | Date: ${parsed.date ? parsed.date.toISOString().slice(0, 10) : 'sem data'}`
        );
      }

      // Corte de data: aplicar SOMENTE quando a variante tem data explícita.
      // Variantes sem data (Lote 1, VIP, Congressista, etc.) passam sem filtro.
      if (parsed.date !== null && parsed.date < DATE_CUTOFF) {
        inscritosIgnorados++;
        continue;
      }

      // ── Cálculo financeiro real ─────────────────────────────────────────────
      const quantidade    = item.quantity || 1;
      const precoCatalogo = parseFloat(item.price) || 0;
      const subtotal      = precoCatalogo * quantidade;
      const current_total_discounts = order.current_total_discounts;

      // 1ª tentativa: desconto no nível do item (campos nativos da Shopify)
      let descontoAplicado =
        item.total_discount !== undefined
          ? (parseFloat(item.total_discount) || 0)
          : (item.discount_allocations || []).reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);

      // 2ª tentativa: a Shopify às vezes aplica cupons globais apenas em order.current_total_discounts,
      // deixando item.total_discount e discount_allocations zerados.
      // Nesse caso distribuímos o desconto do pedido proporcional ao subtotal deste item.
      if (descontoAplicado === 0) {
        const orderDiscount = parseFloat(current_total_discounts) || 0;
        if (orderDiscount > 0) {
          const orderSubtotal = (order.line_items || []).reduce(
            (s, li) => s + (parseFloat(li.price) || 0) * (li.quantity || 1), 0
          );
          const share = orderSubtotal > 0 ? subtotal / orderSubtotal : 1;
          descontoAplicado = Math.min(orderDiscount * share, subtotal);
        }
      }

      const valorFinalPago      = Math.max(0, subtotal - descontoAplicado);
      const valorUnitarioPago   = quantidade > 0 ? valorFinalPago / quantidade : 0;
      const valorFinalCalculado = valorFinalPago;

      // ── Dados de localização e empresa ──────────────────────────────────────
      const cidade = order.billing_address?.city || order.shipping_address?.city || '';
      const estado = order.billing_address?.province || order.shipping_address?.province || '';
      const empresa = order.billing_address?.company || order.customer?.default_address?.company || '';

      const inscritoId = `${order.id}-${variantId}`;
      const inscritoRef = db
        .collection('cursos').doc(String(productId))
        .collection('eventos').doc(variantId)
        .collection('inscritos').doc(inscritoId);

      const now = Timestamp.now();
      let snap;

      try {
        snap = await inscritoRef.get();
      } catch (e) {
        console.log(`  Erro ao ler inscrito ${inscritoId}: ${e.message}`);
        continue;
      }

      console.log({
        subtotal,
        current_total_discounts,
        descontoAplicado,
        valorFinalCalculado,
      });

      const isAtivo = orderFinancialStatus === 'paid';
      const statusLabel = shopifyStatusLabel(orderFinancialStatus, order.cancelled_at);

      // Reaproveita o CPF já salvo — nunca sobrescreve com vazio; só busca quando ainda não há valor.
      const cpfExistente = snap.exists ? (snap.data().cpf || '') : '';
      const cpf = cpfExistente || await getCustomerCpf(order.customer?.id);

      try {
        if (snap.exists) {
          const updateData = {
            pedido: order.name,
            shopifyId: String(order.id),
            productId: String(productId),
            variantId,
            quantidade,
            precoCatalogo,
            descontoAplicado,
            valorUnitarioPago,
            valorFinalPago,
            valor: valorFinalPago,     // campo legado — mantém compatibilidade
            dataCompra: Timestamp.fromDate(new Date(order.created_at)),
            email: order.email || '',
            cliente: getCustomerName(order),
            telefone: getPhone(order),
            cidade,
            estado,
            empresa,
            cpf,
            vendedor,
            variante: variantTitle,
            financialStatus: orderFinancialStatus,
            updatedAt: now,
          };
          // Para inscritos não ativos, sobrescreve o status com o label da Shopify
          if (!isAtivo && statusLabel) updateData.status = statusLabel;
          await inscritoRef.update(updateData);
        } else {
          await inscritoRef.set({
            pedido: order.name,
            shopifyId: String(order.id),
            productId: String(productId),
            variantId,
            quantidade,
            precoCatalogo,
            descontoAplicado,
            valorUnitarioPago,
            valorFinalPago,
            valor: valorFinalPago,     // campo legado
            dataCompra: Timestamp.fromDate(new Date(order.created_at)),
            email: order.email || '',
            cliente: getCustomerName(order),
            telefone: getPhone(order),
            cidade,
            estado,
            empresa,
            cpf,
            vendedor,
            variante: variantTitle,
            financialStatus: orderFinancialStatus,
            status: isAtivo ? 'Não Confirmado' : (statusLabel || 'Pendente'),
            observacao: '',
            createdAt: now,
            updatedAt: now,
          });
        }
        totalInscritos++;
      } catch (e) {
        console.log(`  Erro ao gravar inscrito ${inscritoId}: ${e.message}`);
      }
    }
  }

  console.log(`\nInscritos gravados/atualizados: ${totalInscritos}`);
  console.log(`Inscritos ignorados (data passada / sem variante): ${inscritosIgnorados}`);

  // ─── FASE 4: Agregados de eventos ─────────────────────────────────────────
  console.log('\n=== FASE 4: Agregados de eventos ===');

  let eventosAgregados = 0;
  for (const productId of KNOWN_COURSES.keys()) {
    const cursoRef = db.collection('cursos').doc(String(productId));
    try {
      const eventosSnap = await cursoRef.collection('eventos').get();
      for (const eventoDoc of eventosSnap.docs) {
        const inscritosSnap = await eventoDoc.ref.collection('inscritos').get();
        const allDocs = inscritosSnap.docs;
        // Conta apenas inscritos ativos (pagos) para os agregados do portal
        const total       = allDocs.filter(d => isAtivoData(d.data())).length;
        const confirmados = allDocs.filter(
          d => isAtivoData(d.data()) && isConfirmado(d.data().status)
        ).length;
        await eventoDoc.ref.update({ totalInscritos: total, confirmados, updatedAt: Timestamp.now() });
        eventosAgregados++;
      }
    } catch (e) {
      console.log(`  Erro ao agregar eventos do produto ${productId}: ${e.message}`);
    }
  }
  console.log(`Eventos com agregados atualizados: ${eventosAgregados}`);

  // ─── FASE 5: Agregados de cursos ──────────────────────────────────────────
  // Itera sobre TODOS os 14 IDs, não apenas os que tiveram inscritos nesta sync
  console.log('\n=== FASE 5: Agregados de cursos ===');

  const agora = new Date();

  for (const productId of KNOWN_COURSES.keys()) {
    const cursoRef = db.collection('cursos').doc(String(productId));

    try {
      const eventosSnap = await cursoRef.collection('eventos').get();

      let totalCurso = 0;
      let proximoEventoLabel = '';
      let proximoData = null;

      for (const eventoDoc of eventosSnap.docs) {
        const ev = eventoDoc.data();
        totalCurso += ev.totalInscritos || 0;

        const evDate = ev.data?.toDate?.();
        if (evDate && evDate >= agora) {
          if (!proximoData || evDate < proximoData) {
            proximoData = evDate;
            proximoEventoLabel = ev.varianteTitle || '';
          }
        }
      }

      await cursoRef.set(
        {
          totalInscritos: totalCurso,
          proximoEventoLabel,
          updatedAt: Timestamp.now(),
        },
        { merge: true }
      );
    } catch (e) {
      console.log(`  Erro ao atualizar agregados do curso ${productId}: ${e.message}`);
    }
  }

  // ─── FASE 6: Reconciliação de status ─────────────────────────────────────
  // Garante que inscritos existentes reflitam o estado atual da Shopify,
  // incluindo registros legados sem o campo financialStatus.
  console.log('\n=== FASE 6: Reconciliação de Status ===');

  // 1. Coleta todos os shopifyId presentes no Firestore
  const shopifyIdToRefs = new Map(); // shopifyId → [{ ref, data }]
  for (const productId of KNOWN_COURSES.keys()) {
    const cRef = db.collection('cursos').doc(String(productId));
    try {
      const evSnap = await cRef.collection('eventos').get();
      for (const evDoc of evSnap.docs) {
        const inSnap = await evDoc.ref.collection('inscritos').get();
        for (const inDoc of inSnap.docs) {
          const data = inDoc.data();
          if (!data.shopifyId) continue;
          if (!shopifyIdToRefs.has(data.shopifyId)) shopifyIdToRefs.set(data.shopifyId, []);
          shopifyIdToRefs.get(data.shopifyId).push({ ref: inDoc.ref, data });
        }
      }
    } catch (e) {
      console.log(`  Erro ao ler inscritos do produto ${productId}: ${e.message}`);
    }
  }

  const distinctIds = [...shopifyIdToRefs.keys()];
  console.log(`  ${distinctIds.length} shopifyId(s) únicos encontrados no Firestore`);

  // 2. Busca o status atual de cada pedido na Shopify (em lotes de 250)
  const shopifyStatusMap = new Map(); // orderId → { financial_status, cancelled_at }
  const CHUNK_SIZE = 250;
  for (let i = 0; i < distinctIds.length; i += CHUNK_SIZE) {
    const chunk = distinctIds.slice(i, i + CHUNK_SIZE);
    try {
      const url = `${SHOPIFY_BASE}/orders.json?ids=${chunk.join(',')}&status=any&fields=id,financial_status,cancelled_at&limit=${CHUNK_SIZE}`;
      const { data } = await shopifyGet(url);
      for (const o of data.orders || []) {
        shopifyStatusMap.set(String(o.id), {
          financial_status: o.financial_status,
          cancelled_at:     o.cancelled_at,
        });
      }
    } catch (e) {
      console.log(`  Erro ao buscar lote de pedidos Shopify: ${e.message}`);
    }
  }

  // 3. Atualiza registros que: (a) não possuem financialStatus (backfill), ou
  //    (b) possuem financialStatus divergente do estado atual da Shopify, ou
  //    (c) possuem status operacional desatualizado em relação ao rótulo da Shopify.
  //    A ausência do campo financialStatus, por si só, já obriga a gravação —
  //    mesmo quando o pedido continua pago — para eliminar os registros legados
  //    que nunca passaram por este campo.
  let backfill      = 0; // financialStatus gravado pela primeira vez
  let reconciliados = 0; // financialStatus já existia mas divergia da Shopify
  let statusAlterado = 0; // campo status (operacional) mudou de valor nesta rodada
  let semAlteracao  = 0;
  const now2 = Timestamp.now();

  for (const [shopifyId, refs] of shopifyIdToRefs) {
    const current = shopifyStatusMap.get(shopifyId);
    if (!current) {
      // Pedido não encontrado na Shopify (pode ter sido excluído) — ignorar
      continue;
    }

    const shopifyFS  = current.cancelled_at ? 'cancelled' : current.financial_status;
    const statusLabel = shopifyStatusLabel(current.financial_status, current.cancelled_at);

    for (const { ref, data } of refs) {
      const missingFS = data.financialStatus === undefined;
      const storedFS  = resolveFinancialStatus(data);
      const fsChanged = !missingFS && storedFS !== shopifyFS;
      // Não pago: o status operacional deve sempre refletir o rótulo real da Shopify
      const statusOutdated = shopifyFS !== 'paid' && !!statusLabel && data.status !== statusLabel;

      if (!missingFS && !fsChanged && !statusOutdated) {
        semAlteracao++;
        continue;
      }

      const patch = { financialStatus: shopifyFS, updatedAt: now2 };
      // Atualiza status operacional apenas para registros não pagos.
      // Pago: o status operacional permanece 100% editável pelo operador —
      // o backfill nunca sobrescreve status de um pedido pago.
      if (shopifyFS !== 'paid' && statusLabel) patch.status = statusLabel;

      try {
        await ref.update(patch);
        const origem = missingFS ? '(ausente)' : storedFS;
        console.log(`  ✓ ${missingFS ? 'Backfill' : 'Reconciliado'} ${shopifyId}: ${origem} → ${shopifyFS}${statusLabel && shopifyFS !== 'paid' ? ` (${statusLabel})` : ''}`);
        if (missingFS) backfill++; else reconciliados++;
        if (statusOutdated) statusAlterado++;
      } catch (e) {
        console.log(`  ✗ Erro ao reconciliar ${shopifyId}: ${e.message}`);
      }
    }
  }

  console.log(`Backfill (financialStatus ausente): ${backfill} | Reconciliados (divergência): ${reconciliados} | Status alterado: ${statusAlterado} | Sem alteração: ${semAlteracao}`);

  // ─── Comparação final ─────────────────────────────────────────────────────
  console.log('\n=== Comparação Final ===');
  console.log(`Esperado:               ${KNOWN_COURSES.size} cursos`);
  console.log(`Encontrados na Shopify: ${foundIds.length} produto(s)`);
  console.log(`Sincronizados:          ${cursosSincronizados} curso(s)`);
  console.log(`Ausentes na Shopify:    ${missingIds.length} produto(s)`);
  if (missingIds.length > 0) {
    for (const id of missingIds) {
      console.log(`  ✗ ${id}: "${KNOWN_COURSES.get(id)}"`);
    }
  }

  console.log('\n--- Resumo ---');
  console.log(`Cursos processados    : ${cursosSincronizados}`);
  console.log(`Eventos criados       : ${eventosCreated}`);
  console.log(`Eventos atualizados   : ${eventosUpdated}`);
  console.log(`Eventos desativados   : ${eventosDesativados}`);
  console.log(`Eventos com agregados : ${eventosAgregados}`);
  console.log(`Inscritos processados : ${totalInscritos}`);
  console.log('\n=== Sincronização concluída com sucesso! ===');
  console.log(`Fim: ${new Date().toISOString()}`);
}

sync().catch(err => {
  console.error('\nErro fatal durante a sincronização:', err.message || err);
  process.exit(1);
});
