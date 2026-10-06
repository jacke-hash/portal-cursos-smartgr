// Cloudflare Worker — Shopify Webhook → Firestore
// Evento: orders/paid · orders/create · orders/updated · orders/cancelled · refunds/create · inventory_levels/update · products/create · products/update
import { DATE_CUTOFF, parseVariantTitle, buildEventoFields, isDefaultVariant } from '../../../shared/eventos.mjs';

// ── Catálogo de cursos monitorados ─────────────────────────────────────────────

const KNOWN_COURSES = new Map([
  [8821788115101, 'Treinamento Prático - Prisma Peeling'],
  [8821788180637, 'Treinamento Presencial - Protocolo Peptídeos'],
  [8701283827869, 'Terapias Médicas Baseadas em Eletroporação'],
  [8680458551453, 'Treinamento Presencial de Microagulhamento'],
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

// Todo produto com as 3 tags abaixo é curso, mesmo fora de KNOWN_COURSES.
// Mesma regra de scripts/sync-shopify.mjs (hasCursoTags).
const REQUIRED_TAGS = ['cursos', 'treinamento', 'presencial'];
function hasCursoTags(tags) {
  const set = new Set(String(tags || '').split(',').map(t => t.trim().toLowerCase()));
  return REQUIRED_TAGS.every(t => set.has(t));
}

// Nome do curso se productId é monitorado (KNOWN_COURSES ou tags na Shopify),
// senão null. Line items do pedido não trazem tags, então produto fora de
// KNOWN_COURSES é consultado na API. Lança erro em falha de rede/HTTP (exceto
// 404) pra Shopify refazer a entrega em vez de descartar a inscrição.
async function resolveCurso(productId, env) {
  const known = KNOWN_COURSES.get(productId);
  if (known) return known;
  if (!productId || !env?.SHOPIFY_ACCESS_TOKEN) return null;
  const resp = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${productId}.json?fields=id,title,tags`,
    { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN } }
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Shopify product ${productId}: ${resp.status}`);
  const { product } = await resp.json();
  return hasCursoTags(product?.tags) ? (product.title || '') : null;
}

const SHOPIFY_STORE = 'smart-gr-pro.myshopify.com';

// Mapeia financial_status da Shopify para label operacional do portal.
// Retorna null para 'paid' (o status operacional é mantido pelo operador).
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

// Labels operacionais que identificam um inscrito não pago (mesma lista usada
// no portal e em sync-shopify.mjs — mantém os três em paridade).
const INACTIVE_STATUS_LABELS = new Set([
  'Cancelado', 'Reembolsado', 'Parcialmente Reembolsado',
  'Expirado', 'Pendente', 'Autorizado', 'Anulado',
]);

// Verdadeiro se o inscrito conta como ativo (pago) nos agregados do portal.
function isInscritoAtivo(i) {
  if (i.financialStatus) return i.financialStatus === 'paid';
  return !INACTIVE_STATUS_LABELS.has(i.status);
}

// ── HMAC Shopify ───────────────────────────────────────────────────────────────
// Valida a assinatura enviada no header X-Shopify-Hmac-Sha256.
// Lê o corpo como ArrayBuffer (única leitura permitida no Worker).

async function verifyHmac(bodyBuffer, hmacHeader, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, bodyBuffer);
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return computed === hmacHeader;
}

// ── Firebase Auth (JWT RS256 → OAuth2 access token) ────────────────────────────

function b64url(obj) {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemToBinary(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(email, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header  = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({
    iss: email, sub: email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/datastore',
    iat: now, exp: now + 3600,
  });

  const signingInput = `${header}.${payload}`;
  const pemKey = privateKeyPem.replace(/\\n/g, '\n');

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', pemToBinary(pemKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${sig}`,
    }),
  });

  const data = await resp.json();
  if (!data.access_token) throw new Error(`Firebase auth falhou: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Firestore REST API ─────────────────────────────────────────────────────────

function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = toFsValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromFsValue(v) {
  if (!v) return null;
  if ('nullValue'    in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('stringValue'  in v) return v.stringValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue'     in v) {
    const r = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) r[k] = fromFsValue(val);
    return r;
  }
  return null;
}

function docToObj(doc) {
  if (!doc?.fields) return null;
  const r = {};
  for (const [k, v] of Object.entries(doc.fields)) r[k] = fromFsValue(v);
  return r;
}

function objToFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFsValue(v);
  return fields;
}

class Firestore {
  constructor(projectId, token) {
    this.base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    this.auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  // Lê documento; retorna null se não existir
  async get(path) {
    const resp = await fetch(`${this.base}/${path}`, { headers: this.auth });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Firestore GET /${path}: ${resp.status}`);
    return docToObj(await resp.json());
  }

  // Cria ou sobrescreve documento completo
  async set(path, data) {
    const resp = await fetch(`${this.base}/${path}`, {
      method: 'PATCH',
      headers: this.auth,
      body: JSON.stringify({ fields: objToFields(data) }),
    });
    if (!resp.ok) throw new Error(`Firestore SET /${path}: ${resp.status} ${await resp.text()}`);
  }

  // Atualiza apenas os campos especificados (equivalente a update com merge)
  async patch(path, data) {
    const keys = Object.keys(data);
    const mask = keys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const resp = await fetch(`${this.base}/${path}?${mask}`, {
      method: 'PATCH',
      headers: this.auth,
      body: JSON.stringify({ fields: objToFields(data) }),
    });
    if (!resp.ok) throw new Error(`Firestore PATCH /${path}: ${resp.status} ${await resp.text()}`);
  }

  // Lista todos os documentos de uma coleção (com paginação automática)
  async list(path) {
    const docs = [];
    let pageToken = '';
    do {
      const url = `${this.base}/${path}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const resp = await fetch(url, { headers: this.auth });
      if (!resp.ok) throw new Error(`Firestore LIST /${path}: ${resp.status}`);
      const data = await resp.json();
      for (const doc of data.documents || []) {
        docs.push({ id: doc.name.split('/').pop(), ...docToObj(doc) });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return docs;
  }

  // Verdadeiro se a coleção tem ao menos um documento (1 leitura)
  async hasDocs(path) {
    const resp = await fetch(`${this.base}/${path}?pageSize=1`, { headers: this.auth });
    if (!resp.ok) throw new Error(`Firestore LIST /${path}: ${resp.status}`);
    return ((await resp.json()).documents || []).length > 0;
  }
}

// ── Lógica de domínio ──────────────────────────────────────────────────────────
// Espelhadas de sync-shopify.mjs para garantir paridade.

function calcFinancials(item, order) {
  // current_quantity reflete a quantidade após edições/reembolsos do pedido;
  // quantity é sempre a quantidade original e nunca muda (ex.: pedido editado
  // de 7 para 1 continua com quantity=7, current_quantity=1).
  const quantidade    = item.current_quantity ?? item.quantity ?? 1;
  const precoCatalogo = parseFloat(item.price) || 0;
  const subtotal      = precoCatalogo * quantidade;

  let descontoAplicado =
    item.total_discount !== undefined
      ? (parseFloat(item.total_discount) || 0)
      : (item.discount_allocations || []).reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);

  if (descontoAplicado === 0) {
    const orderDiscount = parseFloat(order.current_total_discounts) || 0;
    if (orderDiscount > 0) {
      const orderSubtotal = (order.line_items || []).reduce(
        (s, li) => s + (parseFloat(li.price) || 0) * (li.current_quantity ?? li.quantity ?? 1), 0
      );
      const share = orderSubtotal > 0 ? subtotal / orderSubtotal : 1;
      descontoAplicado = Math.min(orderDiscount * share, subtotal);
    }
  }

  const valorFinalPago    = Math.max(0, subtotal - descontoAplicado);
  const valorUnitarioPago = quantidade > 0 ? valorFinalPago / quantidade : 0;
  return { quantidade, precoCatalogo, descontoAplicado, valorFinalPago, valorUnitarioPago };
}

// Busca o metafield custom.cpf do cliente. Nunca lança erro — retorna '' em qualquer falha.
async function getCustomerCpf(customerId, accessToken) {
  if (!customerId) return '';
  try {
    const resp = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/customers/${customerId}/metafields.json?namespace=custom&key=cpf`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    if (!resp.ok) return '';
    const data = await resp.json();
    return data.metafields?.[0]?.value || '';
  } catch {
    return '';
  }
}

// Deriva perfil (profissional/estudante/consumidor) e formação a partir do
// checkout: profissional usa a profissão declarada, estudante usa a área de
// estudo declarada — nunca um rótulo fixo. Pedidos antigos sem perfil_cliente
// caem no fallback pelos nomes legados, sem perfil definido.
function extractFormacaoInfo(attributes) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const valor = (key) => attributes.find((a) => norm(a.name) === key)?.value?.trim() || '';
  const perfil = norm(valor('perfil_cliente'));

  if (perfil === 'profissional') {
    // Só médico/dentista têm especialidade_cliente na Shopify — as demais
    // profissões nunca preenchem esse campo, então fica vazio pra elas.
    return { perfil: 'profissional', formacao: valor('profissao_cliente'), especialidade: valor('especialidade_cliente') };
  }
  if (perfil === 'estudante') {
    const area = valor('area_estudo_cliente');
    return { perfil: 'estudante', formacao: area === '-' ? '' : area, especialidade: '' };
  }
  if (perfil === 'consumidor' || perfil === 'consumidor_final' || perfil === 'consumidor final') {
    return { perfil: 'consumidor', formacao: '', especialidade: '' };
  }

  const legado = attributes.find(({ name }) =>
    ['formacao', 'formação', 'profissao', 'profissão', 'profissao_cliente', 'area de atuacao', 'área de atuação', 'ocupacao', 'ocupação']
      .includes(norm(name))
  )?.value || '';
  return { perfil: '', formacao: legado, especialidade: '' };
}

function extractCustomer(order) {
  const attributes = order.note_attributes || [];
  const { perfil, formacao, especialidade } = extractFormacaoInfo(attributes);
  return {
    cliente: [
      order.billing_address?.first_name || order.customer?.first_name || '',
      order.billing_address?.last_name  || order.customer?.last_name  || '',
    ].join(' ').trim(),
    email:    order.email || '',
    telefone: order.billing_address?.phone || order.customer?.phone || order.shipping_address?.phone || '',
    cidade:   order.billing_address?.city     || order.shipping_address?.city     || '',
    estado:   order.billing_address?.province || order.shipping_address?.province || '',
    empresa:  order.billing_address?.company  || order.customer?.default_address?.company || '',
    vendedor: attributes.find(a => a.name === 'Affiliate')?.value || '',
    perfil,
    formacao,
    especialidade,
  };
}

// ── Recalculo de agregados ────────────────────────────────────────────────────

// Estoque atual da variante na Shopify (vagas ainda não vendidas). Nunca
// lança erro — retorna null em qualquer falha, e quem chama simplesmente
// não atualiza o campo (mantém o último valor conhecido).
async function getVariantInventory(variantId, accessToken) {
  if (!accessToken) return null;
  try {
    const resp = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/variants/${variantId}.json?fields=inventory_quantity`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const n = data.variant?.inventory_quantity;
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

// Resolve productId/variantId a partir do inventory_item_id recebido no
// webhook inventory_levels/update — o payload desse tópico só traz
// inventory_item_id + location_id + available, nunca variant/product. A API
// REST não expõe essa relação reversa (inventory_item → variant), então usa
// GraphQL. Nunca lança erro — retorna null em qualquer falha.
async function resolveVariantFromInventoryItem(inventoryItemId, accessToken) {
  if (!accessToken) return null;
  try {
    const query = `query($id: ID!) { inventoryItem(id: $id) { variant { id product { id } } } }`;
    const resp = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { id: `gid://shopify/InventoryItem/${inventoryItemId}` } }),
    });
    if (!resp.ok) {
      console.log(`[resolveVariantFromInventoryItem] HTTP ${resp.status}: ${await resp.text()}`);
      return null;
    }
    const data = await resp.json();
    if (data.errors) console.log(`[resolveVariantFromInventoryItem] GraphQL errors: ${JSON.stringify(data.errors)}`);
    const variant = data?.data?.inventoryItem?.variant;
    if (!variant?.id || !variant?.product?.id) {
      console.log(`[resolveVariantFromInventoryItem] Sem variant/product na resposta: ${JSON.stringify(data)}`);
      return null;
    }
    return {
      variantId:  variant.id.split('/').pop(),
      productId:  Number(variant.product.id.split('/').pop()),
    };
  } catch (e) {
    console.log(`[resolveVariantFromInventoryItem] Exceção: ${e.message}`);
    return null;
  }
}

// Delta de totalInscritos/confirmados causado por UM inscrito mudando de
// estado (existing → isActiveAfter/isConfirmadoAfter). Evita reler a
// subcoleção inteira de inscritos a cada pedido só pra saber esses dois
// números — num evento com centenas de inscritos, isso multiplicava o
// consumo de leitura do Firestore por pedido (estourou a cota do plano
// gratuito numa loja ativa). O chamador já tem `existing` em mãos de
// qualquer forma (precisa dele pra decidir patch vs set).
//
// Conta INGRESSOS (soma de `quantidade`), não pedidos — um pedido com
// quantidade=2 vale 2, não 1. É o mesmo critério do painel do evento
// (eventoInsights soma quantidade dos inscritos ativos); contar só
// documentos fazia esse número divergir do "Ingressos vendidos" sempre
// que alguém comprava mais de 1 ingresso no mesmo pedido.
function isConfirmado(i) {
  return i?.status === 'Confirmado' || i?.status === 'Presente';
}
function qtyOf(i) {
  return Number(i?.quantidade) || 1;
}
function deltaAgregados(existing, isActiveAfter, isConfirmadoAfter, qtyAfter) {
  const qtyBefore      = existing ? qtyOf(existing) : 0;
  const wasActive      = existing ? isInscritoAtivo(existing) : false;
  const wasConfirmado  = existing ? isConfirmado(existing) : false;
  return {
    total:       (isActiveAfter ? qtyAfter : 0) - (wasActive ? qtyBefore : 0),
    confirmados: (isConfirmadoAfter ? qtyAfter : 0) - (wasConfirmado ? qtyBefore : 0),
  };
}

async function recalcEvento(db, productId, variantId, varianteTitle, date, env, delta) {
  // Capacidade disponível: vagas restantes reportadas pela Shopify (estoque
  // da variante). Somada ao total de inscritos ativos, dá a capacidade total
  // do evento — não é armazenada separadamente pra nunca ficar dessincronizada.
  const capacidadeDisponivel = await getVariantInventory(variantId, env?.SHOPIFY_ACCESS_TOKEN);

  const exists = await db.get(`cursos/${productId}/eventos/${variantId}`);
  const patch = { updatedAt: new Date() };
  if (capacidadeDisponivel !== null) patch.capacidadeDisponivel = capacidadeDisponivel;

  if (exists) {
    patch.totalInscritos = Math.max(0, (exists.totalInscritos || 0) + delta.total);
    patch.confirmados    = Math.max(0, (exists.confirmados || 0) + delta.confirmados);
    await db.patch(`cursos/${productId}/eventos/${variantId}`, patch);
  } else {
    await db.set(`cursos/${productId}/eventos/${variantId}`, {
      varianteTitle: varianteTitle || '',
      varianteId: variantId,
      data: date || null,
      ativo: true,
      totalInscritos: Math.max(0, delta.total),
      confirmados: Math.max(0, delta.confirmados),
      ...patch,
    });
  }
}

async function recalcCurso(db, productId, nomeCurso) {
  const eventos        = await db.list(`cursos/${productId}/eventos`);
  const totalInscritos = eventos.reduce((s, e) => s + (e.totalInscritos || 0), 0);
  const agora = new Date();
  let proximoData = null, proximoEventoLabel = '';

  for (const ev of eventos) {
    const evDate = ev.data instanceof Date ? ev.data : null;
    if (evDate && evDate >= agora && (!proximoData || evDate < proximoData)) {
      proximoData = evDate;
      proximoEventoLabel = ev.varianteTitle || '';
    }
  }

  // [fix] Garante nome/ativo mesmo quando este é o primeiro pedido do curso — sem
  // isso o patch só grava os agregados e o documento nasce sem os campos que o
  // portal usa para listar cursos (where ativo == true), deixando-o invisível
  // até alguém rodar scripts/sync-shopify.mjs manualmente.
  const existing = await db.get(`cursos/${productId}`);
  const patch = {
    nome: KNOWN_COURSES.get(productId) || nomeCurso || existing?.nome || '',
    ativo: true,
    totalInscritos, totalEventos: eventos.length, proximoEventoLabel, updatedAt: new Date(),
  };

  // status: só é definido na criação do documento. Nunca sobrescrever aqui —
  // o operador controla esse campo pelo menu de curso no portal (ocultar/
  // encerrar/reativar); se todo pedido reescrevesse status:'active', qualquer
  // curso ocultado/encerrado voltaria a "active" sozinho no próximo pedido.
  if (!existing || existing.status === undefined) {
    patch.status = 'active';
  }

  await db.patch(`cursos/${productId}`, patch);
}

// ── Handlers de pedidos ───────────────────────────────────────────────────────

async function processOrder(db, order, financialStatus, env) {
  const isActive = financialStatus === 'paid';
  // Rótulo operacional para financialStatus não pago (mesma regra de sync-shopify.mjs)
  const statusLabel = shopifyStatusLabel(financialStatus, order.cancelled_at);
  const now      = new Date();
  const affected = [];
  const lineItems = order.line_items || [];

  console.log(`[processOrder] Pedido=${order.name} id=${order.id} itens=${lineItems.length} financialStatus=${financialStatus}`);

  for (const item of lineItems) {
    const productId = Number(item.product_id);
    const courseName = await resolveCurso(productId, env);

    if (!courseName) {
      console.log(`[processOrder] Produto ignorado: product_id=${item.product_id} title="${item.title}"`);
      continue;
    }
    if (!item.variant_id || !item.variant_title) {
      console.log(`[processOrder] Variante ausente: product_id=${item.product_id} variant_id=${item.variant_id}`);
      continue;
    }

    console.log(`[processOrder] Produto identificado: "${courseName}" product_id=${productId} variant="${item.variant_title}"`);

    const parsed = parseVariantTitle(item.variant_title);
    if (!parsed) {
      console.log(`[processOrder] Variante não parseável: "${item.variant_title}"`);
      continue;
    }
    if (parsed.date !== null && parsed.date < DATE_CUTOFF) {
      console.log(`[processOrder] Evento anterior ao corte: date=${parsed.date?.toISOString()} variant="${item.variant_title}"`);
      continue;
    }

    const variantId  = String(item.variant_id);
    const inscritoId = `${order.id}-${variantId}`;
    const path       = `cursos/${productId}/eventos/${variantId}/inscritos/${inscritoId}`;

    console.log(`[processOrder] Evento identificado: variantId=${variantId} date=${parsed.date?.toISOString() || 'sem_data'} local="${parsed.local}"`);

    const fin  = calcFinancials(item, order);
    const cust = extractCustomer(order);

    console.log(`[processOrder] Financeiro: subtotal=${fin.precoCatalogo * fin.quantidade} descontoAplicado=${fin.descontoAplicado} valorFinalPago=${fin.valorFinalPago} cliente="${cust.cliente}"`);

    const existing = await db.get(path);
    // O checkout grava o CPF em note_attributes (cpf_cliente), não no metafield
    // custom.cpf do cliente — esse metafield praticamente nunca é preenchido.
    // Reaproveita o CPF já salvo — nunca sobrescreve com vazio; senão usa o
    // note_attribute (grátis, já veio no payload); só cai pra API do metafield
    // como último recurso, pra pedidos antigos que não tinham esse attribute.
    const cpfAttr = order.note_attributes?.find(a => a.name === 'cpf_cliente')?.value || '';
    const cpf = existing?.cpf || cpfAttr || await getCustomerCpf(order.customer?.id, env.SHOPIFY_ACCESS_TOKEN);

    const base = {
      pedido: order.name, shopifyId: String(order.id),
      productId: String(productId), variantId,
      variante: item.variant_title,
      ...fin, valor: fin.valorFinalPago,
      dataCompra: new Date(order.created_at),
      ...cust, cpf,
      financialStatus,
      updatedAt: now,
    };

    // Confirmado/Presente só é setado por ação manual do operador (fora
    // deste worker) — aqui o status ou fica igual (patch sem tocar `status`)
    // ou é sobrescrito pro rótulo de inativo, nunca vira Confirmado/Presente.
    const isConfirmadoAfter = existing && isActive ? isConfirmado(existing) : false;
    const delta = deltaAgregados(existing, isActive, isConfirmadoAfter, fin.quantidade);

    if (existing) {
      const updateData = { ...base };
      // Registra quando o financialStatus realmente mudou
      if (existing.financialStatus !== financialStatus) updateData.financialStatusUpdatedAt = now;
      // Não pago: sobrescreve o status operacional com o rótulo real da Shopify
      // (evita que um inscrito reembolsado/expirado/etc. continue exibindo um
      // status operacional antigo como "Confirmado").
      if (!isActive && statusLabel) updateData.status = statusLabel;
      await db.patch(path, updateData);
      console.log(`[processOrder] Inscrito atualizado: ${inscritoId} financialStatus=${financialStatus}`);
    } else {
      await db.set(path, {
        ...base,
        status: isActive ? 'Não Confirmado' : (statusLabel || 'Pendente'),
        financialStatusUpdatedAt: now,
        observacao: '',
        impresso: false, impressoEm: null, impressoPor: null,
        createdAt: now,
      });
      console.log(`[processOrder] Inscrito criado: ${inscritoId} financialStatus=${financialStatus} cliente="${cust.cliente}"`);
    }

    affected.push({ productId, courseName, variantId, varianteTitle: item.variant_title, date: parsed.date, delta });
  }

  const seen = new Set();
  for (const { productId, courseName, variantId, varianteTitle, date, delta } of affected) {
    const key = `${productId}:${variantId}`;
    if (!seen.has(key)) {
      seen.add(key);
      await recalcEvento(db, productId, variantId, varianteTitle, date, env, delta);
      await recalcCurso(db, productId, courseName);
      console.log(`[processOrder] Agregados recalculados: curso=${productId} evento=${variantId}`);
    }
  }

  console.log(`[processOrder] Concluído: ${affected.length} inscrição(ões) processada(s)`);
  return affected.length;
}

// Atualiza financialStatus + status de inscritos existentes sem criar novos registros.
// Usada quando orders/updated chega com status não-pago (pending, expired, voided, etc.).
async function updateInscritoFinancialStatus(db, order, financialStatus, env) {
  const statusLabel = shopifyStatusLabel(financialStatus, order.cancelled_at);
  if (!statusLabel) {
    console.log(`[updateInscritoFinancialStatus] Status sem label: ${financialStatus} — ignorado`);
    return;
  }
  const now = new Date();
  for (const item of order.line_items || []) {
    const productId = Number(item.product_id);
    if (!item.variant_id || !(await resolveCurso(productId, env))) continue;

    const variantId  = String(item.variant_id);
    const inscritoId = `${order.id}-${variantId}`;
    const path       = `cursos/${productId}/eventos/${variantId}/inscritos/${inscritoId}`;

    const existing = await db.get(path);
    if (existing) {
      await db.patch(path, { financialStatus, status: statusLabel, updatedAt: now });
      console.log(`[updateInscritoFinancialStatus] ${inscritoId}: ${financialStatus} → "${statusLabel}"`);
      // fs não-pago aqui sempre → inativo, status sempre um rótulo inativo
      const delta = deltaAgregados(existing, false, false, qtyOf(existing));
      await recalcEvento(db, productId, variantId, existing.variante || '', null, env, delta);
      await recalcCurso(db, productId);
    } else {
      console.log(`[updateInscritoFinancialStatus] Inscrito não encontrado: ${inscritoId} — nenhum registro criado`);
    }
  }
}

async function handleCancelled(db, order, env) {
  for (const item of order.line_items || []) {
    const productId = Number(item.product_id);
    if (!item.variant_id || !(await resolveCurso(productId, env))) continue;

    const variantId = String(item.variant_id);
    const path      = `cursos/${productId}/eventos/${variantId}/inscritos/${order.id}-${variantId}`;
    const existing  = await db.get(path);

    if (existing) {
      await db.patch(path, { status: 'Cancelado', financialStatus: 'cancelled', updatedAt: new Date() });
      console.log(`[webhook] Pedido cancelado: ${order.name}`);
      const delta = deltaAgregados(existing, false, false, qtyOf(existing));
      await recalcEvento(db, productId, variantId, existing.variante || '', null, env, delta);
      await recalcCurso(db, productId);
    }
  }
}

// inventory_levels/update dispara por QUALQUER mudança de estoque
// (fulfillment, ajuste manual, não só pedido) — substitui o polling de
// scripts/sync-capacidade.mjs, que dependia de cron do GitHub Actions e na
// prática rodava a cada várias horas em vez dos 5min configurados (deixava
// "vagas restantes" visivelmente desatualizado no portal).
//
// Relê o estoque agregado da variante (mesma getVariantInventory do fluxo de
// pedido) em vez de usar payload.available direto, porque o payload é por
// location — relendo cobre lojas com mais de um local de estoque.
async function handleInventoryLevelUpdate(db, payload, env) {
  const resolved = await resolveVariantFromInventoryItem(payload.inventory_item_id, env.SHOPIFY_ACCESS_TOKEN);
  if (!resolved || !(await resolveCurso(resolved.productId, env))) {
    console.log(`[inventory_levels/update] Item não mapeado a um curso monitorado: inventory_item_id=${payload.inventory_item_id}`);
    return;
  }

  const { productId, variantId } = resolved;
  const path = `cursos/${productId}/eventos/${variantId}`;
  const exists = await db.get(path);
  if (!exists) {
    // Evento ainda sem nenhum pedido — recalcEvento (disparado pelo primeiro
    // pedido) já lê o estoque na criação, nada a fazer aqui.
    console.log(`[inventory_levels/update] Evento ainda não existe: ${path}`);
    return;
  }

  const capacidadeDisponivel = await getVariantInventory(variantId, env.SHOPIFY_ACCESS_TOKEN);
  if (capacidadeDisponivel === null) return;

  await db.patch(path, { capacidadeDisponivel, updatedAt: new Date() });
  console.log(`[inventory_levels/update] ${path}: capacidadeDisponivel = ${capacidadeDisponivel}`);
}

// products/create · products/update: cria o curso e sincroniza os eventos
// (variantes) assim que o produto com as 3 tags é cadastrado/editado na
// Shopify, sem esperar o primeiro pedido. Mesma montagem de evento do
// scripts/sync-shopify.mjs (shared/eventos.mjs): só campos vindos da Shopify
// (título, data, ativo/encerrado, estoque) — nunca totalInscritos/confirmados.
//
// products/update dispara a cada edição (preço, imagem, estoque), então:
//  - tags e variantes vêm do próprio payload (sem chamada à API da Shopify);
//  - só grava evento que não existe ou cujos campos mudaram;
//  - o doc do curso é lido antes de qualquer chamada extra à Shopify.
// Variante "Default Title" (produto sem turmas cadastradas) não gera evento.
function eventoMudou(existing, campos) {
  const t = (d) => (d instanceof Date ? d.getTime() : null);
  return existing.varianteTitle !== campos.varianteTitle
    || t(existing.data) !== t(campos.data)
    || existing.ativo !== campos.ativo
    || existing.encerrado !== campos.encerrado
    || ('capacidadeDisponivel' in campos && existing.capacidadeDisponivel !== campos.capacidadeDisponivel);
}

async function handleProductUpsert(db, payload, env) {
  const productId = Number(payload.id);
  if (!productId || !hasCursoTags(payload.tags)) {
    console.log(`[products] Produto sem as tags de curso: id=${payload.id} tags="${payload.tags || ''}"`);
    return;
  }

  const cursoExiste = !!(await db.get(`cursos/${productId}`));

  // O payload do webhook traz as variantes; só consulta a API se faltarem.
  // Lança erro em falha (500 → Shopify reenvia).
  let variants = payload.variants;
  if (!Array.isArray(variants)) {
    const resp = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${productId}/variants.json?limit=250`,
      { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN } }
    );
    if (!resp.ok) throw new Error(`Shopify variants ${productId}: ${resp.status}`);
    variants = (await resp.json()).variants || [];
  }
  // IDs de todas as variantes atuais (inclusive "Default Title"): só quem não
  // está aqui é órfão. Mesmo critério de scripts/sync-shopify.mjs.
  const variantIds = new Set(variants.map(v => String(v.id)));
  variants = variants.filter(v => !isDefaultVariant(v));

  let criados = 0, atualizados = 0, desativados = 0;
  // Sem nenhuma variante no payload (não deveria ocorrer): não mexe nos eventos
  if (variantIds.size) {
    const existentes = new Map((await db.list(`cursos/${productId}/eventos`)).map(e => [e.id, e]));
    const now = new Date();
    for (const variant of variants) {
      const campos = buildEventoFields(variant, now);
      if (!campos) {
        console.log(`[products] Variante ignorada (título inválido ou anterior ao corte): "${variant.title}"`);
        continue;
      }
      const existing = existentes.get(campos.varianteId);
      if (existing && !eventoMudou(existing, campos)) continue;
      await db.patch(`cursos/${productId}/eventos/${campos.varianteId}`, { ...campos, updatedAt: now });
      if (existing) atualizados++; else criados++;
    }

    // Órfãos: evento no Firestore cuja variante não existe mais na Shopify.
    // Desativa só se não tiver inscritos (nunca apaga); com inscritos, só avisa.
    for (const [id, ev] of existentes) {
      if (variantIds.has(id) || ev.ativo === false) continue;
      const path = `cursos/${productId}/eventos/${id}`;
      if ((ev.totalInscritos || 0) > 0 || await db.hasDocs(`${path}/inscritos`)) {
        console.log(`[products] AVISO: evento órfão com inscritos, mantido ativo: ${path} "${ev.varianteTitle || ''}"`);
        continue;
      }
      await db.patch(path, { ativo: false, encerrado: true, updatedAt: now });
      desativados++;
      console.log(`[products] Evento órfão desativado: ${path} "${ev.varianteTitle || ''}"`);
    }
  }

  // Recalcula agregados do curso (totalEventos, próximo evento) só se algo mudou
  if (!cursoExiste || criados || atualizados || desativados) {
    await recalcCurso(db, productId, payload.title || '');
  }
  console.log(`[products] ${productId} "${payload.title}": curso ${cursoExiste ? 'existente' : 'criado'}, eventos ${criados} criado(s) / ${atualizados} atualizado(s) / ${desativados} desativado(s)`);
}

// ── Entry point ────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Lê o corpo UMA ÚNICA VEZ (ArrayBuffer) para HMAC + JSON
    const bodyBuffer = await request.arrayBuffer();
    const hmacHeader = request.headers.get('X-Shopify-Hmac-Sha256');

    if (!hmacHeader || !(await verifyHmac(bodyBuffer, hmacHeader, env.SHOPIFY_WEBHOOK_SECRET))) {
      console.log('[webhook] Webhook inválido: HMAC rejeitado');
      return new Response('Unauthorized', { status: 401 });
    }

    const topic = request.headers.get('X-Shopify-Topic') || '';
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bodyBuffer));
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    console.log(`[webhook] Recebido: ${topic} | pedido=${payload.name || ''} id=${payload.id || ''}`);

    // Inicializa Firestore com token OAuth2
    let db;
    try {
      const token = await getAccessToken(env.FIREBASE_SERVICE_ACCOUNT_EMAIL, env.FIREBASE_PRIVATE_KEY);
      db = new Firestore(env.FIREBASE_PROJECT_ID, token);
    } catch (e) {
      console.error('[webhook] Falha auth Firebase:', e.message);
      return new Response('Internal Server Error', { status: 500 });
    }

    try {
      switch (topic) {
        // orders/paid: pagamento confirmado — sempre criar/atualizar inscrito
        case 'orders/paid': {
          const n = await processOrder(db, payload, 'paid', env);
          console.log(`[webhook] Pedido pago ${payload.name}: ${n} inscrição(ões) persistida(s)`);
          break;
        }

        // orders/create: criado mas ainda não necessariamente pago.
        // Só processar se já estiver pago (ex.: pagamento instantâneo).
        // Para pedidos não pagos, aguardar o evento orders/paid.
        case 'orders/create': {
          if (payload.financial_status === 'paid') {
            const n = await processOrder(db, payload, 'paid', env);
            console.log(`[webhook] Pedido criado (pago) ${payload.name}: ${n} inscrição(ões)`);
          } else {
            console.log(`[webhook] Pedido criado (${payload.financial_status}) ${payload.name}: aguardando orders/paid`);
          }
          break;
        }

        // orders/updated: atualiza status conforme o estado atual da Shopify.
        case 'orders/updated': {
          // closed_at: pedido arquivado/fechado. Não indica cancelamento nem
          // reembolso — um pedido pago pode ser arquivado e continua sendo um
          // inscrito ativo. O sinal de cancelamento é sempre cancelled_at.
          if (payload.closed_at) {
            console.log(`[webhook] Pedido arquivado (closed_at=${payload.closed_at}) ${payload.name}: financial_status=${payload.financial_status} mantido`);
          }

          if (payload.cancelled_at) {
            // Pedido cancelado: handleCancelled define financialStatus='cancelled'
            await handleCancelled(db, payload, env);
            console.log(`[webhook] Pedido cancelado (via updated) ${payload.name}`);
          } else {
            const fs = payload.financial_status;
            if (fs === 'paid' || fs === 'refunded' || fs === 'partially_refunded') {
              // Processar normalmente (cria ou atualiza inscrito com financialStatus correto)
              const n = await processOrder(db, payload, fs, env);
              console.log(`[webhook] Pedido atualizado ${payload.name}: ${n} inscrição(ões) financialStatus=${fs}`);
            } else {
              // Pedido não pago (pending, authorized, expired, voided): atualiza status de registros existentes
              await updateInscritoFinancialStatus(db, payload, fs, env);
              console.log(`[webhook] Status atualizado ${payload.name}: financialStatus=${fs}`);
            }
          }
          break;
        }

        case 'orders/cancelled': {
          await handleCancelled(db, payload, env);
          console.log(`[webhook] Pedido cancelado ${payload.name}`);
          break;
        }

        case 'refunds/create': {
          // O payload de reembolso não inclui line_items — busca o pedido completo
          const orderId   = payload.order_id;
          const orderResp = await fetch(
            `https://${SHOPIFY_STORE}/admin/api/2024-01/orders/${orderId}.json`,
            { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN } }
          );
          if (!orderResp.ok) throw new Error(`Shopify order fetch: ${orderResp.status}`);
          const { order } = await orderResp.json();
          // Usa o financial_status real do pedido (refunded ou partially_refunded)
          await processOrder(db, order, order.financial_status, env);
          console.log(`[webhook] Reembolso ${payload.id} processado: financialStatus=${order.financial_status}`);
          break;
        }

        case 'inventory_levels/update': {
          await handleInventoryLevelUpdate(db, payload, env);
          break;
        }

        case 'products/create':
        case 'products/update': {
          await handleProductUpsert(db, payload, env);
          break;
        }

        default:
          console.log(`[webhook] Tópico não tratado: ${topic}`);
      }
    } catch (e) {
      console.error(`[webhook] Erro ao processar ${topic}:`, e.message);
      return new Response('Internal Server Error', { status: 500 });
    }

    // Shopify exige 200 em até 5s — qualquer outro código força retry
    return new Response('OK', { status: 200 });
  },
};
