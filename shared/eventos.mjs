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
