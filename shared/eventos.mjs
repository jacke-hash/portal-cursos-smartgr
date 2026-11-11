// Lógica de eventos (variantes Shopify) compartilhada entre
// scripts/sync-shopify.mjs (Node + firebase-admin) e
// workers/shopify-webhook (Cloudflare Worker + Firestore REST).
// Sem dependências de runtime: só JS puro, roda nos dois.

// Ignorar variantes com data anterior a 01/06/2026
export const DATE_CUTOFF = new Date('2026-06-01T12:00:00.000Z');

// Parseia variante.
// Formato com data: "13/07/2026 - São Paulo (Zona Sul)" → { date: Date, local: string }
// Formato sem data: "Lote 1", "VIP", "Congressista"    → { date: null, local: string }
// Retorna null apenas se title for vazio ou não-string.
export function parseVariantTitle(title) {
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

// Evento encerrado quando a data de calendário é <= hoje (inclui o próprio dia).
// "Hoje" é sempre o dia em America/Sao_Paulo, e a data do evento (gravada às
// 12:00Z) é lida em UTC — assim o resultado não depende do fuso de quem roda
// (máquina local vs. Worker em UTC).
export function isEventoEncerrado(date, now = new Date()) {
  if (!date) return false;
  const hoje = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
  return date.toISOString().slice(0, 10) <= hoje;
}

// Produto sem opções reais: a Shopify cria uma única variante "Default Title".
export function isDefaultVariant(variant) {
  return variant?.title === 'Default Title';
}

// Curso online (tag "Online") sem turmas: a variante única vira um evento fixo
// "Online", sem data, sempre ativo — é nele que as inscrições são gravadas.
export const TITULO_EVENTO_ONLINE = 'Online';

export function hasOnlineTag(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return list.some(t => String(t).trim().toLowerCase() === 'online');
}

// Aula Master + Maratona Black Friday: o produto era "Online" (variante única,
// já removida da Shopify) e passou a ter lotes. Pedidos antigos ainda carregam o
// variant_id legado; webhooks/reconciliação os redirecionam ao lote correto:
// preço de catálogo >= 99 (virada de 28/10) → 2º lote; antes disso → 1º lote.
export const VARIANTE_LEGADA_BLACK_FRIDAY = {
  legada: '67842414379051',
  lote1:  { id: '68124170321963', titulo: '1º lote' },
  lote2:  { id: '68124170354731', titulo: '2º lote' },
};
export const PRECO_VIRADA_LOTE2 = 99;

// Smart Day Formadores 17/01: as 3 variantes originais foram trocadas por uma
// única ("17/01 das 9h às 18h", id novo). Pedidos anteriores (e os feitos com o
// produto em "Default Title", sem título) carregam o variant_id antigo.
export const VARIANTE_LEGADA_SMART_DAY_FORMADORES = {
  legadas: ['68036896784427', '68036896817195', '68036896849963'], // Dois dias, Dia 1, Dia 2
  destino: { id: '68241053515819', titulo: '17/01 das 9h às 18h' },
};

export function remapVarianteLegada(item) {
  const id = String(item?.variant_id);
  const bf = VARIANTE_LEGADA_BLACK_FRIDAY;
  if (id === bf.legada) {
    const destino = (parseFloat(item.price) || 0) >= PRECO_VIRADA_LOTE2 ? bf.lote2 : bf.lote1;
    return { ...item, variant_id: Number(destino.id), variant_title: destino.titulo };
  }
  const sd = VARIANTE_LEGADA_SMART_DAY_FORMADORES;
  if (sd.legadas.includes(id)) {
    return { ...item, variant_id: Number(sd.destino.id), variant_title: sd.destino.titulo };
  }
  return item;
}

// Status do curso no portal a partir do status do produto na Shopify.
// Rascunho/arquivado → 'draft' (some da listagem padrão); ao publicar, 'draft'
// volta a 'active'. 'hidden'/'finished' são decisão do operador no portal e
// nunca são sobrescritos. Retorna o novo status, ou null se nada muda.
export function statusCursoPorShopify(shopifyStatus, statusAtual) {
  const rascunho = shopifyStatus === 'draft' || shopifyStatus === 'archived';
  if (rascunho) return (statusAtual === undefined || statusAtual === 'active') ? 'draft' : null;
  if (shopifyStatus === 'active' && statusAtual === 'draft') return 'active';
  return null;
}

// Cupons usados no pedido (order.discount_codes), em maiúsculas e sem repetição,
// separados por ", ". Desconto automático (sem código) e pedido sem desconto
// resultam em '' — o portal mostra "Sem cupom".
export function extractCupom(order) {
  const codigos = (order?.discount_codes || [])
    .map(d => String(d?.code || '').trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(codigos)].join(', ');
}

// Variante de line item de pedido sem opção real: título ausente ou "Default Title".
export function isVarianteSemTitulo(title) {
  return !title || title === 'Default Title';
}

export function buildEventoOnlineFields(variant) {
  return {
    varianteTitle: TITULO_EVENTO_ONLINE,
    varianteId:    String(variant.id),
    data:          null,
    ativo:         true,
    encerrado:     false,
    ...(typeof variant.inventory_quantity === 'number' ? { capacidadeDisponivel: variant.inventory_quantity } : {}),
  };
}

// Campos do evento que vêm da Shopify (título, data, estoque). Nunca inclui
// totalInscritos/confirmados/agregados — esses são do portal/webhook de pedidos.
// Retorna null se a variante não gera evento (título inválido ou antes do corte).
// `data` é Date (cada cliente Firestore converte pro seu tipo de timestamp).
// capacidadeDisponivel só entra quando a Shopify reporta um número, pra nunca
// zerar um valor bom por uma falha pontual da API.
export function buildEventoFields(variant, now = new Date()) {
  const variantTitle = variant.title || '';
  const parsed = parseVariantTitle(variantTitle);
  if (!parsed) return null;

  const { date } = parsed;
  if (date !== null && date < DATE_CUTOFF) return null;

  const encerrado = isEventoEncerrado(date, now);
  return {
    varianteTitle: variantTitle,
    varianteId:    String(variant.id),
    data:          date,
    ativo:         !encerrado,
    encerrado,
    ...(typeof variant.inventory_quantity === 'number' ? { capacidadeDisponivel: variant.inventory_quantity } : {}),
  };
}

// Campos de um evento tratado como encerrado por regra de negócio (ex.: variante
// "Default Title" — produto sem turmas reais). Só desativa: nunca apaga o evento
// nem seus inscritos.
export function buildEventoEncerradoFields() {
  return { ativo: false, encerrado: true };
}
