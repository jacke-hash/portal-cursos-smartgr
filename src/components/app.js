import {
  listenCursos,
  listenEncerrados,
  listenEventos,
  listenInscritos,
  updateInscrito,
} from "../services/firestore.js";
import { formatDate, formatSync, money, statusClass } from "../utils/format.js";
import { icon } from "../utils/icons.js";

const LOGO = "https://cdn.shopify.com/s/files/1/0727/8480/6045/files/logo_smart_gr_-_azul.svg?v=1773686608";

// Statuses editáveis pelo operador (apenas para inscritos pagos)
const OPERATIONAL_STATUSES = [
  "Não Confirmado", "Confirmado", "Presente",
  "Ausente", "Remanejado", "Desistente",
];

// Statuses derivados da Shopify (inscritos não ativos — somente leitura no portal)
const INACTIVE_STATUS_LABELS = new Set([
  "Cancelado", "Reembolsado", "Parcialmente Reembolsado",
  "Expirado", "Pendente", "Autorizado", "Anulado",
]);

// Lista completa para o filtro de status (inclui ativos e inativos)
const STATUSES = [
  ...OPERATIONAL_STATUSES,
  "Cancelado", "Reembolsado", "Parcialmente Reembolsado",
  "Expirado", "Pendente", "Autorizado", "Anulado",
];

// Um inscrito é considerado ativo (pago) se:
// - possui financialStatus === 'paid', OU
// - não possui financialStatus E o status não é um label de inativo (compatibilidade com registros legados)
function isInscritoAtivo(i) {
  if (i.financialStatus) return i.financialStatus === 'paid';
  return !INACTIVE_STATUS_LABELS.has(i.status);
}

const PAGE_SIZE = 25;

// [exceção] Cursos cujas variações (eventos) nunca devem ser ocultadas por
// estarem encerradas/expiradas — ex.: "8° Congresso" tem uma variação passada
// que precisa continuar visível. Identificamos pelo `id` do curso (o
// productId da Shopify, imutável) e não pelo `nome`: o campo `nome` é
// sincronizado a partir do título do produto na Shopify (scripts/sync-shopify.mjs)
// e pode ser renomeado a qualquer momento sem aviso — hoje, por exemplo, o
// nome real desse curso no Firestore já é "8º Congresso Mundial Smart GR +
// Estética In São Paulo - 2027", não "8° Congresso". Usar o nome quebraria a
// regra silenciosamente na próxima renomeação; o id nunca muda.
const SEMPRE_EXIBIR_EVENTOS_ENCERRADOS_IDS = ["8928830193821"]; // 8° Congresso

function deveExibirTodosEventos(curso) {
  return SEMPRE_EXIBIR_EVENTOS_ENCERRADOS_IDS.includes(curso?.id);
}

// [alteração 2] Chave única para persistência de navegação no localStorage
const LS_KEY = "smartgr_portal_v1";

// ─── UTILS ───────────────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function normalize(str) {
  return (str || "").toString().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Mantém apenas dígitos — permite buscar CPF com ou sem pontuação (062.994.758-97 == 06299475897)
function normalizeDigits(str) {
  return (str || "").toString().replace(/\D/g, "");
}

// Extrai Date de qualquer formato que o Firestore possa entregar
function extractEventDate(raw) {
  if (!raw) return null;
  if (typeof raw.toDate === "function") return raw.toDate();
  if (raw instanceof Date) return isNaN(raw) ? null : raw;
  if (typeof raw.seconds === "number") {
    return new Date(raw.seconds * 1000 + Math.round((raw.nanoseconds || 0) / 1e6));
  }
  if (typeof raw === "string") { const d = new Date(raw); return isNaN(d) ? null : d; }
  return null;
}

// Evento encerrado quando a DATA DE CALENDÁRIO é <= hoje (inclui eventos do dia atual)
function isEventoPast(evento) {
  const d = extractEventDate(evento.data);
  if (!d) return false;
  const today = new Date();
  const evDay    = new Date(d.getFullYear(),     d.getMonth(),     d.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return evDay <= todayDay;
}

function valorPago(inscrito) {
  return inscrito.valorFinalPago ?? inscrito.valorLiquidoPago ?? inscrito.valor ?? 0;
}

function splitName(fullName) {
  if (!fullName) return { nome: "", sobrenome: "" };
  const parts = fullName.trim().split(" ");
  return { nome: parts[0] || "", sobrenome: parts.slice(1).join(" ") || "" };
}

// ─── LOCALSTORAGE ────────────────────────────────────────────────────────────
// [alteração 2] Funções de persistência: salva e carrega navegação completa

function saveNav() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      route: state.route,
      cursoId: state.curso?.id || null,
      eventoId: state.evento?.id || null,
      eventoSearch: state.eventoSearch,
      search: state.search,
      filters: state.filters,
      sortKey: state.sortKey,
      sortDir: state.sortDir,
      page: state.page,
      scrollY: window.scrollY
    }));
  } catch (_) {}
}

function loadNav() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

// ─── STATE ───────────────────────────────────────────────────────────────────

let state = {
  route: "cursos",
  cursos: [],
  eventos: [],      // ativo: true  (futuros)
  encerrados: [],   // encerrado: true (passados)
  inscritos: [],
  curso: null,
  evento: null,
  search: "",
  eventoSearch: "",
  showPastEventos: false,
  filters: { status: "", vendedor: "", variante: "", impresso: "", inativos: "" },
  sortKey: "dataCompra",
  sortDir: "desc",
  page: 1,
  selectedIds: new Set(),   // seleção manual de inscritos (bulk actions)
  // [fix] Flags de "primeiro snapshot recebido" — evitam mostrar "nenhum resultado"
  // antes do Firestore responder (corrida entre render() inicial e onSnapshot assíncrono)
  cursosLoaded: false,
  eventosLoaded: false,
  encerradosLoaded: false,
  inscritosLoaded: false,
};

let unsubCursos    = null;
let unsubEventos   = null;
let unsubEncerrados = null;
let unsubInscritos = null;
let pendingRestore = null; // [alteração 2] aguarda dados do Firestore para restaurar
let root;

// ─── INIT ────────────────────────────────────────────────────────────────────

export function renderApp(target) {
  root = target;
  // [alteração 2] carrega estado salvo antes de qualquer render
  pendingRestore = loadNav();
  root.innerHTML = shell();
  bindGlobalEvents();
  // [alteração 2] salva posição de scroll no unload para restaurar após F5
  window.addEventListener("beforeunload", saveNav);

  unsubCursos = listenCursos((cursos) => {
    state.cursos = cursos;
    // [fix] marca que o primeiro snapshot já chegou — libera a UI de "loading"
    state.cursosLoaded = true;
    // [alteração 2] na primeira chegada de dados, tenta restaurar navegação
    if (pendingRestore) {
      tryRestore();
      return;
    }
    if (state.route === "cursos") {
      const grid = root.querySelector("#course-grid");
      if (grid) grid.innerHTML = courseGridContent();
    }
  });
  render();
}

// Busca um evento em ativos ou encerrados — usado tanto ao abrir pelo card
// quanto ao restaurar a navegação após F5, para tratar os dois casos igual.
function findEvento(eventoId) {
  return state.eventos.find(e => e.id === eventoId) || state.encerrados.find(e => e.id === eventoId);
}

// [alteração 2] Restaura navegação salva assim que Firestore entrega os cursos
function tryRestore() {
  const saved = pendingRestore;
  pendingRestore = null;

  if (!saved || !saved.cursoId || saved.route === "cursos") {
    if (saved?.search) state.search = saved.search;
    const grid = root.querySelector("#course-grid");
    if (grid) grid.innerHTML = courseGridContent();
    return;
  }

  const curso = state.cursos.find(c => c.id === saved.cursoId);
  if (!curso) {
    // Curso não existe mais — fica na tela inicial
    const grid = root.querySelector("#course-grid");
    if (grid) grid.innerHTML = courseGridContent();
    return;
  }

  state.curso = curso;
  state.route = "curso";
  state.eventos    = [];
  state.encerrados = [];
  // [fix] reseta as flags de loading — a UI mostra "carregando" até o próximo snapshot
  state.eventosLoaded = false;
  state.encerradosLoaded = false;
  state.eventoSearch = saved.eventoSearch || "";
  state.showPastEventos = false;
  state.page = 1;

  if (unsubEventos)    unsubEventos();
  if (unsubEncerrados) unsubEncerrados();

  const savedEventoId = saved.eventoId;
  const savedRoute = saved.route;
  const savedScrollY = saved.scrollY || 0;
  let didAttemptEvento = false;
  // Eventos ativos e encerrados chegam de listeners independentes, em ordem não
  // garantida. Só tentamos restaurar o evento salvo depois que AMBOS entregarem
  // o primeiro snapshot — assim não importa se ele está em ativos ou encerrados.
  let eventosLoaded = false;
  let encerradosLoaded = false;

  function attemptRestoreEvento() {
    if (didAttemptEvento || savedRoute !== "evento" || !savedEventoId) return;
    if (!eventosLoaded || !encerradosLoaded) return;
    didAttemptEvento = true;

    const evento = findEvento(savedEventoId);
    if (evento) {
      state.search = saved.search || "";
      state.filters = { status: "", vendedor: "", variante: "", impresso: "", inativos: "", ...(saved.filters || {}) };
      state.sortKey = saved.sortKey || "dataCompra";
      state.sortDir = saved.sortDir || "desc";
      state.page = saved.page || 1;
      _restoreOpenEvento(evento, savedScrollY);
    }
  }

  // Encerrados carregados em paralelo para exibir o contador no botão
  unsubEncerrados = listenEncerrados(curso.id, (encerrados) => {
    state.encerrados = encerrados;
    state.encerradosLoaded = true;
    encerradosLoaded = true;
    attemptRestoreEvento();
    if (state.route === "curso") {
      if (root.querySelector("#eventos-content")) cursoEventosPartialUpdate();
      else render();
    }
  });

  unsubEventos = listenEventos(curso.id, (eventos) => {
    state.eventos = eventos;
    state.eventosLoaded = true;
    eventosLoaded = true;
    attemptRestoreEvento();

    if (state.route === "curso") {
      if (root.querySelector("#eventos-content")) {
        cursoEventosPartialUpdate();
      } else {
        render();
      }
    }
  });

  render(); // exibe cursoView imediatamente enquanto eventos carregam
}

// [alteração 2] Reabre evento salvo e restaura scroll
function _restoreOpenEvento(evento, scrollY) {
  state.evento = evento;
  state.route = "evento";
  state.inscritos = [];
  // [fix] reseta a flag de loading — a tabela mostra "carregando" até o próximo snapshot
  state.inscritosLoaded = false;

  if (unsubInscritos) unsubInscritos();
  unsubInscritos = listenInscritos(state.curso.id, evento.id, (inscritos) => {
    state.inscritos = inscritos;
    state.inscritosLoaded = true;
    if (state.route === "evento") {
      if (root.querySelector("#inscritos-tbody")) {
        const scroll = document.documentElement.scrollTop || document.body.scrollTop;
        eventoViewPartialUpdate();
        document.documentElement.scrollTop = scroll;
        document.body.scrollTop = scroll;
      } else {
        render();
      }
    }
  });

  render();
  // [alteração 2] restaura posição de scroll após render
  if (scrollY) requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

// ─── SHELL ───────────────────────────────────────────────────────────────────

function shell() {
  return `
    <div class="app-shell">
      <header class="topbar">
        <button class="brand" data-action="go-cursos">
          <img src="${LOGO}" alt="SmartGR">
        </button>
        <span class="sync-pill"><i></i>Firestore em tempo real</span>
      </header>
      <main id="view"></main>
    </div>
  `;
}

function bindGlobalEvents() {
  root.addEventListener("click", handleClick);
  root.addEventListener("input", handleInput);
  root.addEventListener("change", handleChange);
}

// [alteração 8] removido bindDynamicEvents() vazio — era chamada morta
function render() {
  const scrollY = document.documentElement.scrollTop || document.body.scrollTop;
  const view = root.querySelector("#view");
  if (state.route === "cursos") view.innerHTML = cursosView();
  else if (state.route === "curso") view.innerHTML = cursoView();
  else if (state.route === "evento") view.innerHTML = eventoView();
  document.documentElement.scrollTop = scrollY;
  document.body.scrollTop = scrollY;
}

// ─── VIEWS ───────────────────────────────────────────────────────────────────

function filteredCursos() {
  if (!state.search) return state.cursos;
  const q = normalize(state.search);
  return state.cursos.filter(c => normalize(c.nome).includes(q));
}

function courseGridContent() {
  // [fix] Enquanto o primeiro snapshot do Firestore não chegou, mostra loading
  // em vez de "nenhum curso encontrado" — evita o flash de vazio ao recarregar (F5)
  if (!state.cursosLoaded) return loading("Carregando cursos...");
  const filtered = filteredCursos();
  return filtered.length ? filtered.map(courseCard).join("") : empty("Nenhum curso encontrado.");
}

function cursosView() {
  return `
    <section class="page-head">
      <div>
        <p class="eyebrow">Portal operacional</p>
        <h1>RELAÇÃO DE INSCRITOS</h1>
      </div>
      <input class="search" data-action="search-cursos" placeholder="Buscar curso..." value="${state.search}">
    </section>
    <section class="course-grid" id="course-grid">
      ${courseGridContent()}
    </section>
  `;
}

function courseCard(curso) {
  return `
    <button class="course-card" data-action="open-curso" data-curso-id="${curso.id}">
      <strong class="course-name">${curso.nome}</strong>
      <div class="card-footer">
        <span class="card-updated-label">Atualizado em</span>
        <span class="card-updated-value">${formatSync(curso.updatedAt)}</span>
      </div>
    </button>
  `;
}

// [alteração 5] Deduplica eventos pelo variantId antes de exibir
function dedupeEventos(eventos) {
  const seen = new Map();
  for (const e of eventos) {
    const key = e.variantId || e.varianteId || e.id;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, e);
    } else {
      const ta = existing.updatedAt?.toDate?.()?.getTime() || 0;
      const tb = e.updatedAt?.toDate?.()?.getTime() || 0;
      if (tb > ta) seen.set(key, e);
    }
  }
  return [...seen.values()];
}

// Usa os arrays já classificados pelo Firestore (ativo/encerrado)
function computeEventoSections() {
  // state.eventos   = ativo: true  (futuros) — já ordenados por data asc pelo Firestore
  // state.encerrados = encerrado: true (passados) — ordenados por data desc (client-side)
  const future = dedupeEventos(state.eventos);
  const past   = dedupeEventos(state.encerrados);

  console.log("[SmartGR] Eventos totais:", future.length + past.length);
  console.log("[SmartGR] Eventos futuros:", future.length);
  console.log("[SmartGR] Eventos encerrados:", past.length);

  const q = normalize(state.eventoSearch.trim());
  const applySearch = list => q
    ? list.filter(e => normalize(e.varianteTitle || e.id).includes(q))
    : list;

  return {
    future: applySearch(future),
    past:   applySearch(past),
    pastCount:   past.length,
    futureCount: future.length,
    // [exceção] ver SEMPRE_EXIBIR_EVENTOS_ENCERRADOS_IDS — força a exibição das
    // variações encerradas para cursos específicos, sem afetar os demais.
    sempreExibirEncerrados: deveExibirTodosEventos(state.curso),
  };
}

// [alteração 1] Exibe encerrados apenas quando toggle ativo
function eventoGridContent(sections) {
  // [fix] mesma corrida do course-grid: aguarda o primeiro snapshot de eventos
  if (!state.eventosLoaded) {
    return `<div class="loading" style="grid-column:1/-1">Carregando eventos...</div>`;
  }
  const { future, past, sempreExibirEncerrados } = sections;
  let html = future.length
    ? future.map(eventoCard).join("")
    : `<div class="empty" style="grid-column:1/-1">Nenhum evento futuro encontrado.</div>`;

  if ((state.showPastEventos || sempreExibirEncerrados) && past.length) {
    html += `<div class="encerrados-sep" style="grid-column:1/-1"><span class="encerrados-label">Eventos Encerrados</span></div>`;
    html += past.map(eventoCard).join("");
  }
  return html;
}

function cursoView() {
  if (!state.curso) return empty("Curso não encontrado.");
  const sections = computeEventoSections();
  const { pastCount, futureCount, sempreExibirEncerrados } = sections;

  return `
    <section class="page-head">
      <div>
        <button class="back-btn" data-action="go-cursos">← Cursos</button>
        <h2>${state.curso.nome}</h2>
      </div>
    </section>
    <div class="stats-bar" id="curso-stats-bar">
      ${statCard("Eventos futuros", futureCount)}
      ${statCard("Eventos encerrados", pastCount)}
    </div>
    <div class="eventos-toolbar">
      <input class="search" data-action="search-evento"
             placeholder="Buscar evento..." value="${state.eventoSearch}">
      ${pastCount > 0 && !sempreExibirEncerrados ? `
        <button class="btn-toggle-past ${state.showPastEventos ? "active" : ""}"
                data-action="toggle-past-eventos">
          ${state.showPastEventos ? "Ocultar eventos encerrados" : `Mostrar encerrados (${pastCount})`}
        </button>` : ""}
    </div>
    <section class="eventos-grid" id="eventos-content">
      ${eventoGridContent(sections)}
    </section>
  `;
}

function eventoCard(evento) {
  const evDate = extractEventDate(evento.data);
  // Usa o campo Firestore quando disponível; fallback para comparação de data
  const isPast = evento.encerrado === true || isEventoPast(evento);
  const dateLabel = evDate
    ? evDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "";
  const statusBadge = evDate
    ? `<span class="evento-status ${isPast ? "evento-status-encerrado" : "evento-status-ativo"}">${isPast ? "Encerrado" : "Ativo"}</span>`
    : "";

  return `
    <button class="evento-card${isPast ? " evento-past" : ""}"
            data-action="open-evento" data-evento-id="${evento.id}">
      <strong>${evento.varianteTitle || evento.id}</strong>
      ${dateLabel ? `<span class="evento-date">${dateLabel}</span>` : ""}
      ${statusBadge}
      <div class="card-meta">
        <span><b>${evento.totalInscritos || 0}</b> inscritos</span>
        <span><b>${evento.confirmados || 0}</b> confirmados</span>
      </div>
    </button>
  `;
}

function inscritosStats() {
  const all     = state.inscritos;
  const ativos  = all.filter(isInscritoAtivo);
  const inativos = all.filter(i => !isInscritoAtivo(i));
  return {
    // Contagens operacionais — apenas inscritos pagos
    total:          ativos.length,
    confirmados:    ativos.filter(i => i.status === "Confirmado" || i.status === "Presente").length,
    naoConfirmados: ativos.filter(i => i.status === "Não Confirmado").length,
    presentes:      ativos.filter(i => i.status === "Presente").length,
    ausentes:       ativos.filter(i => i.status === "Ausente").length,
    desistentes:    ativos.filter(i => i.status === "Desistente").length,
    impressos:      ativos.filter(i => i.impresso === true).length,
    // Contagens de inativos — apenas para auditoria
    cancelados:        inativos.filter(i => i.financialStatus === "cancelled"         || i.status === "Cancelado").length,
    reembolsados:      inativos.filter(i => i.financialStatus === "refunded"          || i.status === "Reembolsado").length,
    parcReembolsados:  inativos.filter(i => i.financialStatus === "partially_refunded"|| i.status === "Parcialmente Reembolsado").length,
    expirados:         inativos.filter(i => i.financialStatus === "expired"           || i.status === "Expirado").length,
    pendentes:         inativos.filter(i => i.financialStatus === "pending"           || i.status === "Pendente").length,
    anulados:          inativos.filter(i => i.financialStatus === "voided"            || i.status === "Anulado").length,
    autorizados:       inativos.filter(i => i.financialStatus === "authorized"        || i.status === "Autorizado").length,
    totalInativos:     inativos.length,
  };
}

function _filtersBar(vendedores, variantes) {
  return `
    <div class="filters-bar">
      <div class="filter-wrap filter-wrap--grow">
        <span class="filter-icon">${icon.search()}</span>
        <input class="search" data-action="search" placeholder="Buscar pedido, nome, email, CPF, telefone, vendedor, cidade..." value="${state.search}">
      </div>
      <select class="filter-select" data-filter="status">
        <option value="">Todos os status</option>
        ${STATUSES.map(s => `<option value="${s}" ${state.filters.status === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <select class="filter-select" data-filter="vendedor">
        <option value="">Todos os vendedores</option>
        ${vendedores.map(v => `<option value="${v}" ${state.filters.vendedor === v ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <select class="filter-select" data-filter="variante">
        <option value="">Todas as variantes</option>
        ${variantes.map(v => `<option value="${v}" ${state.filters.variante === v ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <select class="filter-select" data-filter="impresso">
        <option value="">Impressos: todos</option>
        <option value="true" ${state.filters.impresso === "true" ? "selected" : ""}>Somente Impressos</option>
        <option value="false" ${state.filters.impresso === "false" ? "selected" : ""}>Somente Pendentes</option>
      </select>
      <select class="filter-select" data-filter="inativos">
        <option value="">Somente pagos</option>
        <option value="all"  ${state.filters.inativos === "all"  ? "selected" : ""}>Todos (incluindo inativos)</option>
        <option value="only" ${state.filters.inativos === "only" ? "selected" : ""}>Somente inativos</option>
      </select>
      ${hasFilters() ? `<button class="btn-clear" data-action="clear-filters">Limpar filtros</button>` : ""}
    </div>`;
}

function _tableSection(paginated, colSpan = 13) {
  const filtered = filteredInscritos();
  const allSelected = filtered.length > 0 && filtered.every(i => state.selectedIds.has(i.id));
  // [fix] enquanto o primeiro snapshot de inscritos não chegou, mostra "carregando"
  // em vez de "nenhum inscrito encontrado" — evita o flash de vazio ao abrir o evento
  const tbodyContent = !state.inscritosLoaded
    ? `<tr><td colspan="${colSpan}" class="empty-row">Carregando inscritos...</td></tr>`
    : (paginated.length
        ? paginated.map(inscritoRow).join("")
        : `<tr><td colspan="${colSpan}" class="empty-row">Nenhum inscrito encontrado.</td></tr>`);
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th class="check-col">
              <input type="checkbox" class="select-all-check" data-action="select-all" ${allSelected ? "checked" : ""} title="Selecionar todos">
            </th>
            ${th("pedido", "Pedido")}
            ${th("valorFinalPago", "Valor Pago")}
            ${th("dataCompra", "Data Compra")}
            ${th("telefone", "Telefone")}
            ${th("cpf", "CPF")}
            ${th("email", "Email")}
            ${th("cliente", "Cliente")}
            ${th("variante", "Variante")}
            ${th("vendedor", "Vendedor")}
            <th>Status</th>
            <th>Observação</th>
            <th>Impresso</th>
          </tr>
        </thead>
        <tbody id="inscritos-tbody">
          ${tbodyContent}
        </tbody>
      </table>
    </div>`;
}

function eventoView() {
  if (!state.evento) return empty("Evento não encontrado.");
  const inscritos = filteredInscritos();
  const paginated = inscritos.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  const totalPages = Math.ceil(inscritos.length / PAGE_SIZE);
  const vendedores = [...new Set(state.inscritos.map(i => i.vendedor).filter(Boolean))];
  const variantes  = [...new Set(state.inscritos.map(i => i.variante).filter(Boolean))];
  const stats = inscritosStats();

  return `
    <section class="page-head">
      <div class="page-head-left">
        <button class="back-btn" data-action="go-curso">← ${state.curso?.nome || "Curso"}</button>
        <h2>${state.evento.varianteTitle || state.evento.id}</h2>
      </div>
      <div class="page-head-right">
        ${printCounterBar(stats)}
        <div class="export-btns">
          ${exportDropdown(inscritos, stats)}
        </div>
      </div>
    </section>

    <div class="stats-bar" id="stats-bar">
      ${statCard("Total Pagos",      stats.total,          "",               icon.users())}
      ${statCard("Confirmados",      stats.confirmados,    "confirmado",     icon.checkCircle())}
      ${statCard("Não Confirmados",  stats.naoConfirmados, "nao-confirmado", icon.clock3())}
      ${statCard("Presentes",        stats.presentes,      "presente",       icon.mapPin())}
      ${statCard("Ausentes",         stats.ausentes,       "ausente",        icon.userX())}
      ${statCard("Desistentes",      stats.desistentes,    "desistente",     icon.userMinus())}
      ${statCard("Cancelados",       stats.cancelados,     "cancelado",      icon.xCircle())}
      ${statCard("Reembolsados",     stats.reembolsados,   "reembolsado",    icon.wallet())}
      ${stats.parcReembolsados > 0 ? statCard("Parc. Reembolsados", stats.parcReembolsados, "parcialmente-reembolsado", icon.wallet()) : ""}
      ${stats.expirados        > 0 ? statCard("Expirados",           stats.expirados,         "expirado",                icon.clock3())  : ""}
      ${stats.pendentes        > 0 ? statCard("Pendentes",           stats.pendentes,          "pendente",                icon.clock3())  : ""}
      ${stats.anulados         > 0 ? statCard("Anulados",            stats.anulados,           "anulado",                 icon.xCircle()) : ""}
      ${stats.autorizados      > 0 ? statCard("Autorizados",         stats.autorizados,        "autorizado",              icon.clock3())  : ""}
    </div>

    ${batchActionsBar()}

    <div class="filters-toolbar">
      <button class="btn-filters-toggle" data-action="toggle-filters-mobile">
        ${icon.filter()} Filtros${hasFilters() ? " ●" : ""}
      </button>
      <p class="results-count" id="results-count">${inscritos.length} inscrito${inscritos.length !== 1 ? "s" : ""} encontrado${inscritos.length !== 1 ? "s" : ""}</p>
    </div>

    ${_filtersBar(vendedores, variantes)}

    <div class="mobile-cards" id="mobile-cards">
      ${!state.inscritosLoaded
        ? `<p class="empty-row">Carregando inscritos...</p>`
        : (paginated.length ? paginated.map(inscritoCard).join("") : `<p class="empty-row">Nenhum inscrito encontrado.</p>`)}
    </div>

    ${_tableSection(paginated)}

    <div id="pagination-wrap">${totalPages > 1 ? pagination(state.page, totalPages) : ""}</div>
  `;
}

function batchActionsBar() {
  const n = state.selectedIds.size;
  if (n === 0) return `<div id="batch-bar"></div>`;
  return `
    <div id="batch-bar" class="batch-bar">
      <span class="batch-count">${n} selecionado${n > 1 ? "s" : ""}</span>
      <div class="batch-actions">
        <button class="batch-btn" data-action="batch-confirmado">✓ Confirmar</button>
        <button class="batch-btn" data-action="batch-presente">📍 Presente</button>
        <button class="batch-btn" data-action="batch-impresso">🖨 Marcar Impresso</button>
        <button class="batch-btn batch-btn--export" data-action="export-selecionados">⬇ Exportar</button>
        <button class="batch-btn batch-btn--clear" data-action="clear-selection">✕</button>
      </div>
    </div>`;
}

function printCounterBar(stats) {
  const total = stats.total; // apenas pagos
  const imp   = stats.impressos;
  const pend  = total - imp;
  const pct   = total > 0 ? Math.round((imp / total) * 100) : 0;
  return `
    <div class="print-counter-bar">
      <span class="pcount pcount--imp">🖨 ${imp} impresso${imp !== 1 ? "s" : ""}</span>
      <span class="pcount-sep">·</span>
      <span class="pcount pcount--pend">📄 ${pend} pendente${pend !== 1 ? "s" : ""}</span>
      <div class="pcount-bar" title="${pct}%">
        <div class="pcount-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
}

function exportDropdown(inscritos, stats) {
  const n = state.selectedIds.size;
  const tot = stats.total;
  const imp = stats.impressos;
  const pend = tot - imp;
  return `
    <details class="export-details" id="export-details">
      <summary class="btn-export">${icon.fileSpreadsheet()} Exportar ▾</summary>
      <div class="export-dropdown">
        <p class="dd-label">Filtrados (${inscritos.length})</p>
        <button class="dd-item" data-action="export-excel">${icon.fileSpreadsheet(16)} Excel</button>
        <button class="dd-item" data-action="export-csv">${icon.fileText(16)} CSV</button>
        <hr class="dd-sep">
        <p class="dd-label">Todos (${tot})</p>
        <button class="dd-item" data-action="export-tudo-excel">${icon.fileSpreadsheet(16)} Excel</button>
        <button class="dd-item" data-action="export-tudo-csv">${icon.fileText(16)} CSV</button>
        <hr class="dd-sep">
        <button class="dd-item" data-action="export-impressos">🖨 Impressos (${imp})</button>
        <button class="dd-item" data-action="export-pendentes">📄 Pendentes (${pend})</button>
        <hr class="dd-sep">
        <button class="dd-item${n === 0 ? " dd-item--disabled" : ""}" data-action="export-selecionados" ${n === 0 ? "disabled" : ""}>
          ☑ Selecionados (${n})
        </button>
      </div>
    </details>`;
}

function statCard(label, value, variant = "", iconHtml = "") {
  const cls = variant ? ` stat-card--${variant}` : "";
  return `
    <div class="stat-card${cls}">
      <div class="stat-icon">${iconHtml}</div>
      <b class="stat-value">${value}</b>
      <span class="stat-label">${label}</span>
    </div>`;
}

function th(key, label) {
  const active = state.sortKey === key;
  const dir = active ? (state.sortDir === "asc" ? "↑" : "↓") : "";
  return `<th class="sortable ${active ? "sort-active" : ""}" data-sort="${key}">${label} ${dir}</th>`;
}

function inscritoRow(inscrito) {
  const cls   = statusClass(inscrito.status || "");
  const sel   = state.selectedIds.has(inscrito.id);
  const ativo = isInscritoAtivo(inscrito);
  const rowClasses = [sel ? "row-selected" : "", !ativo ? "row-inativo" : ""].filter(Boolean).join(" ");
  return `
    <tr data-inscrito-id="${inscrito.id}"${rowClasses ? ` class="${rowClasses}"` : ""}>
      <td class="check-col">
        <input type="checkbox" class="row-check" data-action="toggle-select" data-inscrito-id="${inscrito.id}" ${sel ? "checked" : ""}>
      </td>
      <td>${inscrito.pedido || "--"}</td>
      <td>${money.format(valorPago(inscrito))}</td>
      <td>${formatDate(inscrito.dataCompra)}</td>
      <td>${inscrito.telefone || "--"}</td>
      <td>${inscrito.cpf || "CPF não informado"}</td>
      <td>${inscrito.email || "--"}</td>
      <td class="${!ativo ? "td-nome-inativo" : ""}">${inscrito.cliente || "--"}</td>
      <td>${inscrito.variante || "--"}</td>
      <td>${inscrito.vendedor || "--"}</td>
      <td>
        ${ativo
          ? `<select class="status-select status-${cls}" data-action="change-status" data-inscrito-id="${inscrito.id}">
              ${OPERATIONAL_STATUSES.map(s => `<option value="${s}" ${inscrito.status === s ? "selected" : ""}>${s}</option>`).join("")}
             </select>`
          : `<span class="status-inactive-badge status-${cls}">${inscrito.status || "—"}</span>`
        }
      </td>
      <td>
        <input class="note" placeholder="Adicionar observação..."
               value="${(inscrito.observacao || "").replace(/"/g, "&quot;")}"
               data-action="change-obs" data-inscrito-id="${inscrito.id}">
      </td>
      <td>
        <button class="impresso-btn${inscrito.impresso ? " ativo" : ""}"
                data-action="toggle-impresso" data-inscrito-id="${inscrito.id}">
          ${inscrito.impresso ? "☑ Impresso" : "☐ Pendente"}
        </button>
      </td>
    </tr>
  `;
}

function inscritoCard(inscrito) {
  const cls   = statusClass(inscrito.status || "");
  const sel   = state.selectedIds.has(inscrito.id);
  const ativo = isInscritoAtivo(inscrito);
  const cardClasses = ["mobile-card", sel ? "mobile-card--selected" : "", !ativo ? "mobile-card--inactive" : ""].filter(Boolean).join(" ");
  return `
    <div class="${cardClasses}" data-inscrito-id="${inscrito.id}">
      <div class="mc-top">
        <input type="checkbox" class="row-check mc-check" data-action="toggle-select" data-inscrito-id="${inscrito.id}" ${sel ? "checked" : ""}>
        <span class="mc-pedido">${inscrito.pedido || "--"}</span>
        <span class="mc-valor">${money.format(valorPago(inscrito))}</span>
      </div>
      <div class="mc-body">
        <strong class="mc-nome${!ativo ? " nome-inativo" : ""}">${inscrito.cliente || "--"}</strong>
        <span class="mc-email">${inscrito.email || ""}</span>
        <div class="mc-meta">
          ${inscrito.telefone ? `<span>📞 ${inscrito.telefone}</span>` : ""}
          <span>🪪 ${inscrito.cpf || "CPF não informado"}</span>
          ${inscrito.cidade   ? `<span>📍 ${inscrito.cidade}${inscrito.estado ? " – " + inscrito.estado : ""}</span>` : ""}
          ${inscrito.vendedor ? `<span>👤 ${inscrito.vendedor}</span>` : ""}
        </div>
      </div>
      <div class="mc-bottom">
        ${ativo
          ? `<select class="status-select status-${cls}" data-action="change-status" data-inscrito-id="${inscrito.id}">
               ${OPERATIONAL_STATUSES.map(s => `<option value="${s}" ${inscrito.status === s ? "selected" : ""}>${s}</option>`).join("")}
             </select>`
          : `<span class="status-inactive-badge status-${cls}">${inscrito.status || "—"}</span>`
        }
        <button class="impresso-btn${inscrito.impresso ? " ativo" : ""}" data-action="toggle-impresso" data-inscrito-id="${inscrito.id}">
          ${inscrito.impresso ? "☑ Impresso" : "☐ Pendente"}
        </button>
        ${ativo ? `
        <button class="mc-action-btn" data-action="quick-confirmado" data-inscrito-id="${inscrito.id}">✓</button>
        <button class="mc-action-btn" data-action="quick-presente" data-inscrito-id="${inscrito.id}">📍</button>` : ""}
      </div>
    </div>`;
}

function pagination(page, total) {
  return `
    <div class="pagination">
      <button data-action="prev-page" ${page === 1 ? "disabled" : ""}>Anterior</button>
      <span>Página ${page} de ${total}</span>
      <button data-action="next-page" ${page === total ? "disabled" : ""}>Próxima</button>
    </div>
  `;
}

function empty(msg) {
  return `<div class="empty">${msg}</div>`;
}

function loading(msg) {
  return `<div class="loading">${msg}</div>`;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function filteredInscritos() {
  let list = [...state.inscritos];

  // Filtro de atividade: por padrão exibe apenas inscritos pagos.
  // Quando o usuário seleciona um status inativo explicitamente, inclui inativos.
  const filteringByInactiveStatus = state.filters.status && INACTIVE_STATUS_LABELS.has(state.filters.status);
  if (state.filters.inativos === "only") {
    list = list.filter(i => !isInscritoAtivo(i));
  } else if (state.filters.inativos === "all" || filteringByInactiveStatus) {
    // exibe tudo
  } else {
    list = list.filter(isInscritoAtivo);
  }

  if (state.search) {
    const q = normalize(state.search);
    const qDigits = normalizeDigits(state.search);
    list = list.filter(i => {
      const matchesTexto = [i.pedido, i.cliente, i.email, i.cpf, i.telefone,
        i.cidade, i.estado, i.variante, i.vendedor, formatDate(i.dataCompra)]
        .some(v => normalize(v).includes(q));
      // Busca por CPF ignorando pontuação — "06299475897" encontra "062.994.758-97"
      const matchesCpf = qDigits && normalizeDigits(i.cpf).includes(qDigits);
      return matchesTexto || matchesCpf;
    });
  }

  if (state.filters.status)   list = list.filter(i => i.status === state.filters.status);
  if (state.filters.vendedor) list = list.filter(i => i.vendedor === state.filters.vendedor);
  if (state.filters.variante) list = list.filter(i => i.variante === state.filters.variante);
  if (state.filters.impresso === "true")  list = list.filter(i => i.impresso === true);
  if (state.filters.impresso === "false") list = list.filter(i => !i.impresso);

  list.sort((a, b) => {
    let av = state.sortKey === "valorFinalPago" ? valorPago(a) : (a[state.sortKey] ?? "");
    let bv = state.sortKey === "valorFinalPago" ? valorPago(b) : (b[state.sortKey] ?? "");
    if (av?.toDate) av = av.toDate();
    if (bv?.toDate) bv = bv.toDate();
    if (av < bv) return state.sortDir === "asc" ? -1 : 1;
    if (av > bv) return state.sortDir === "asc" ? 1 : -1;
    return 0;
  });

  return list;
}

function hasFilters() {
  return state.search || Object.values(state.filters).some(Boolean);
}

// ─── HELPERS INTERNOS ────────────────────────────────────────────────────────

function inscritosSelecionados() {
  return [...state.selectedIds]
    .map(id => state.inscritos.find(i => i.id === id))
    .filter(Boolean);
}

function _partialUpdateSelection() {
  const batchBar = root.querySelector("#batch-bar");
  if (batchBar) batchBar.outerHTML = batchActionsBar();

  const filtered = filteredInscritos();
  const allSelected = filtered.length > 0 && filtered.every(i => state.selectedIds.has(i.id));
  const selectAll = root.querySelector(".select-all-check");
  if (selectAll) selectAll.checked = allSelected;

  root.querySelectorAll(".row-check").forEach(cb => {
    cb.checked = state.selectedIds.has(cb.dataset.inscritoId);
  });
  root.querySelectorAll(".mobile-card").forEach(card => {
    const id = card.dataset.inscritoId;
    card.classList.toggle("mobile-card--selected", state.selectedIds.has(id));
    const cb = card.querySelector(".row-check");
    if (cb) cb.checked = state.selectedIds.has(id);
  });
}

// ─── PARTIAL UPDATES ─────────────────────────────────────────────────────────
// [alteração 4] Re-render cirúrgico preserva contexto do usuário sem refresh total

// [fix] Atualiza as <option> de um <select> de filtro preservando o valor selecionado.
// Necessário porque os selects de vendedor/variante só têm dados depois que o
// Firestore entrega os inscritos — bem depois do render inicial da tela.
function _updateFilterSelectOptions(selector, defaultLabel, values, currentValue) {
  const el = root.querySelector(selector);
  if (!el) return;
  const html = [`<option value="">${defaultLabel}</option>`]
    .concat(values.map(v => `<option value="${v}" ${currentValue === v ? "selected" : ""}>${v}</option>`))
    .join("");
  if (el.innerHTML !== html) el.innerHTML = html;
}

function eventoViewPartialUpdate() {
  const inscritos    = filteredInscritos();
  const paginated    = inscritos.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  const totalPages   = Math.ceil(inscritos.length / PAGE_SIZE);
  const stats        = inscritosStats();
  const vendedores   = [...new Set(state.inscritos.map(i => i.vendedor).filter(Boolean))];
  const variantes    = [...new Set(state.inscritos.map(i => i.variante).filter(Boolean))];

  const statsBar       = root.querySelector("#stats-bar");
  const resultsCount   = root.querySelector("#results-count");
  const tbody          = root.querySelector("#inscritos-tbody");
  const paginationWrap = root.querySelector("#pagination-wrap");
  const mobileCards    = root.querySelector("#mobile-cards");
  const batchBar       = root.querySelector("#batch-bar");
  const printCounter   = root.querySelector(".print-counter-bar");
  const exportDetails  = root.querySelector("#export-details");
  const filtersToolbar = root.querySelector(".filters-toolbar");
  const filtersBtnDot  = root.querySelector(".btn-filters-toggle");

  if (statsBar) statsBar.innerHTML =
    statCard("Total Pagos",      stats.total,          "",               icon.users()) +
    statCard("Confirmados",      stats.confirmados,    "confirmado",     icon.checkCircle()) +
    statCard("Não Confirmados",  stats.naoConfirmados, "nao-confirmado", icon.clock3()) +
    statCard("Presentes",        stats.presentes,      "presente",       icon.mapPin()) +
    statCard("Ausentes",         stats.ausentes,       "ausente",        icon.userX()) +
    statCard("Desistentes",      stats.desistentes,    "desistente",     icon.userMinus()) +
    statCard("Cancelados",       stats.cancelados,     "cancelado",      icon.xCircle()) +
    statCard("Reembolsados",     stats.reembolsados,   "reembolsado",    icon.wallet()) +
    (stats.parcReembolsados > 0 ? statCard("Parc. Reembolsados", stats.parcReembolsados, "parcialmente-reembolsado", icon.wallet()) : "") +
    (stats.expirados        > 0 ? statCard("Expirados",           stats.expirados,         "expirado",                icon.clock3())  : "") +
    (stats.pendentes        > 0 ? statCard("Pendentes",           stats.pendentes,          "pendente",                icon.clock3())  : "") +
    (stats.anulados         > 0 ? statCard("Anulados",            stats.anulados,           "anulado",                 icon.xCircle()) : "") +
    (stats.autorizados      > 0 ? statCard("Autorizados",         stats.autorizados,        "autorizado",              icon.clock3())  : "");

  if (batchBar) batchBar.outerHTML = batchActionsBar();

  if (printCounter) printCounter.outerHTML = printCounterBar(stats);

  if (exportDetails) exportDetails.outerHTML = exportDropdown(inscritos, stats);

  if (resultsCount) {
    const n = inscritos.length;
    resultsCount.textContent = `${n} inscrito${n !== 1 ? "s" : ""} encontrado${n !== 1 ? "s" : ""}`;
  }

  if (filtersBtnDot) {
    filtersBtnDot.innerHTML = `${icon.filter()} Filtros${hasFilters() ? " ●" : ""}`;
  }

  // [fix] Bug do filtro de vendedores: os arrays `vendedores`/`variantes` eram
  // calculados aqui mas nunca aplicados aos <select> — a lista ficava sempre
  // vazia ("Todos os vendedores") depois do primeiro snapshot de inscritos,
  // porque o full render inicial roda ANTES do Firestore entregar os dados,
  // e este é o único ponto que atualiza a tela depois disso.
  _updateFilterSelectOptions('[data-filter="vendedor"]', "Todos os vendedores", vendedores, state.filters.vendedor);
  _updateFilterSelectOptions('[data-filter="variante"]', "Todas as variantes", variantes, state.filters.variante);

  if (tbody) tbody.innerHTML = !state.inscritosLoaded
    ? `<tr><td colspan="13" class="empty-row">Carregando inscritos...</td></tr>`
    : (paginated.length
        ? paginated.map(inscritoRow).join("")
        : `<tr><td colspan="13" class="empty-row">Nenhum inscrito encontrado.</td></tr>`);

  if (mobileCards) mobileCards.innerHTML = !state.inscritosLoaded
    ? `<p class="empty-row">Carregando inscritos...</p>`
    : (paginated.length
        ? paginated.map(inscritoCard).join("")
        : `<p class="empty-row">Nenhum inscrito encontrado.</p>`);

  // Sync checkbox states after table/card repaint
  const filtered = filteredInscritos();
  const allSelected = filtered.length > 0 && filtered.every(i => state.selectedIds.has(i.id));
  const selectAll = root.querySelector(".select-all-check");
  if (selectAll) selectAll.checked = allSelected;

  if (paginationWrap) paginationWrap.innerHTML = totalPages > 1 ? pagination(state.page, totalPages) : "";
}

function cursoEventosPartialUpdate() {
  const sections = computeEventoSections();
  const { pastCount, futureCount, sempreExibirEncerrados } = sections;

  const statsBar    = root.querySelector("#curso-stats-bar");
  const eventosGrid = root.querySelector("#eventos-content");
  const toggleBtn   = root.querySelector("[data-action='toggle-past-eventos']");

  if (statsBar) statsBar.innerHTML =
    statCard("Eventos futuros", futureCount) +
    statCard("Eventos encerrados", pastCount);

  if (eventosGrid) eventosGrid.innerHTML = eventoGridContent(sections);

  if (toggleBtn) {
    toggleBtn.className = `btn-toggle-past${state.showPastEventos ? " active" : ""}`;
    toggleBtn.textContent = state.showPastEventos
      ? "Ocultar eventos encerrados"
      : `Mostrar encerrados (${pastCount})`;
  }

  // pastCount surgiu (primeiro evento encerrado adicionado): re-renderiza para mostrar o toggle
  // — exceto quando sempreExibirEncerrados, caso em que o toggle nunca é renderizado de propósito.
  if (pastCount > 0 && !toggleBtn && !sempreExibirEncerrados) render();
}

// ─── EVENTOS ─────────────────────────────────────────────────────────────────

function handleClick(e) {
  const el = e.target.closest("[data-action]");
  if (el) {
    const action = el.dataset.action;

    if (action === "go-cursos") {
      goToCursos();
    } else if (action === "open-curso") {
      openCurso(el.dataset.cursoId);
    } else if (action === "go-curso") {
      goToCurso();
    } else if (action === "open-evento") {
      openEvento(el.dataset.eventoId);
    } else if (action === "clear-filters") {
      state.filters = { status: "", vendedor: "", variante: "", impresso: "", inativos: "" };
      state.search = "";
      state.page = 1;
      saveNav();
      render();
    } else if (action === "prev-page") {
      state.page--;
      saveNav();
      render();
    } else if (action === "next-page") {
      state.page++;
      saveNav();
      render();
    } else if (action === "toggle-past-eventos") {
      state.showPastEventos = !state.showPastEventos;
      saveNav();
      cursoEventosPartialUpdate();
    } else if (action === "toggle-impresso") {
      const id = el.dataset.inscritoId;
      const inscrito = state.inscritos.find(i => i.id === id);
      if (inscrito) {
        const novoImpresso = !inscrito.impresso;
        updateInscrito(state.curso.id, state.evento.id, id, {
          impresso: novoImpresso,
          impressoEm: novoImpresso ? new Date() : null,
          impressoPor: "",
        });
      }
    } else if (action === "export-excel") {
      exportExcel();
    } else if (action === "export-csv") {
      exportCSV();
    } else if (action === "export-tudo-excel") {
      exportTudo("excel");
    } else if (action === "export-tudo-csv") {
      exportTudo("csv");
    } else if (action === "export-impressos") {
      exportImpressos();
    } else if (action === "export-pendentes") {
      exportPendentes();
    } else if (action === "export-selecionados") {
      exportSelecionados();

    // ── Seleção manual ────────────────────────────────────────────────────────
    } else if (action === "select-all") {
      const filtered = filteredInscritos();
      if (state.selectedIds.size === filtered.length && filtered.length > 0) {
        state.selectedIds = new Set();
      } else {
        state.selectedIds = new Set(filtered.map(i => i.id));
      }
      _partialUpdateSelection();
    } else if (action === "toggle-select") {
      const id = el.dataset.inscritoId;
      if (state.selectedIds.has(id)) state.selectedIds.delete(id);
      else state.selectedIds.add(id);
      _partialUpdateSelection();
    } else if (action === "clear-selection") {
      state.selectedIds = new Set();
      _partialUpdateSelection();

    // ── Ações em lote ─────────────────────────────────────────────────────────
    } else if (action === "batch-impresso") {
      for (const id of state.selectedIds) {
        updateInscrito(state.curso.id, state.evento.id, id, { impresso: true, impressoEm: new Date(), impressoPor: "" });
      }
    } else if (action === "batch-confirmado") {
      for (const id of state.selectedIds) {
        updateInscrito(state.curso.id, state.evento.id, id, { status: "Confirmado" });
      }
      state.selectedIds = new Set();
      _partialUpdateSelection();
    } else if (action === "batch-presente") {
      for (const id of state.selectedIds) {
        updateInscrito(state.curso.id, state.evento.id, id, { status: "Presente" });
      }
      state.selectedIds = new Set();
      _partialUpdateSelection();

    // ── Ações rápidas mobile ──────────────────────────────────────────────────
    } else if (action === "quick-confirmado") {
      updateInscrito(state.curso.id, state.evento.id, el.dataset.inscritoId, { status: "Confirmado" });
    } else if (action === "quick-presente") {
      updateInscrito(state.curso.id, state.evento.id, el.dataset.inscritoId, { status: "Presente" });

    // ── Mobile: filtros toggle ────────────────────────────────────────────────
    } else if (action === "toggle-filters-mobile") {
      const bar = root.querySelector(".filters-bar");
      if (bar) bar.classList.toggle("filters-open");
      el.classList.toggle("active");
    }
  }

  const sortEl = e.target.closest("[data-sort]");
  if (sortEl) {
    const key = sortEl.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = "asc";
    }
    state.page = 1;
    saveNav();
    render();
  }
}

// [alteração 3] Busca em tempo real via evento input — sem exigir blur ou clique extra
const _debouncedCursoSearch = debounce(() => {
  const grid = root.querySelector("#course-grid");
  if (grid) grid.innerHTML = courseGridContent();
  saveNav();
}, 200);

const _debouncedEventoSearch = debounce(() => {
  const grid = root.querySelector("#eventos-content");
  if (grid) grid.innerHTML = eventoGridContent(computeEventoSections());
  saveNav();
}, 200);

const _debouncedInscritoSearch = debounce(() => {
  eventoViewPartialUpdate();
  saveNav();
}, 200);

function handleInput(e) {
  const action = e.target.dataset.action;

  if (action === "search-cursos") {
    state.search = e.target.value;
    _debouncedCursoSearch();
    return;
  }
  if (action === "search") {
    state.search = e.target.value;
    state.page = 1;
    _debouncedInscritoSearch();
    return;
  }
  if (action === "search-evento") {
    state.eventoSearch = e.target.value;
    _debouncedEventoSearch();
    return;
  }
  if (action === "change-obs") {
    const id = e.target.dataset.inscritoId;
    clearTimeout(e.target._debounce);
    e.target._debounce = setTimeout(() => {
      updateInscrito(state.curso.id, state.evento.id, id, { observacao: e.target.value });
    }, 800);
  }
}

function handleChange(e) {
  if (e.target.dataset.filter !== undefined) {
    state.filters[e.target.dataset.filter] = e.target.value;
    state.page = 1;
    saveNav();
    render();
  }
  if (e.target.dataset.action === "change-status") {
    const id = e.target.dataset.inscritoId;
    // feedback visual imediato sem esperar o round-trip do Firestore
    e.target.className = `status-select status-${statusClass(e.target.value)}`;
    updateInscrito(state.curso.id, state.evento.id, id, { status: e.target.value });
  }
}

// ─── NAVEGAÇÃO ────────────────────────────────────────────────────────────────
// [alteração 7] saveNav() em todas as transições preserva contexto após F5

function goToCursos() {
  if (unsubEventos)    { unsubEventos();    unsubEventos    = null; }
  if (unsubEncerrados) { unsubEncerrados(); unsubEncerrados = null; }
  if (unsubInscritos)  { unsubInscritos();  unsubInscritos  = null; }
  state.route = "cursos";
  state.curso = null;
  state.evento = null;
  state.eventos    = [];
  state.encerrados = [];
  state.inscritos  = [];
  state.search = "";
  state.eventoSearch = "";
  state.showPastEventos = false;
  state.filters = { status: "", vendedor: "", variante: "", impresso: "" };
  state.page = 1;
  saveNav();
  render();
}

function openCurso(cursoId) {
  const curso = state.cursos.find(c => c.id === cursoId);
  if (!curso) return;
  state.curso = curso;
  state.route = "curso";
  state.eventos    = [];
  state.encerrados = [];
  // [fix] reseta as flags de loading — a UI mostra "carregando" até o próximo snapshot
  state.eventosLoaded = false;
  state.encerradosLoaded = false;
  state.search = "";
  state.eventoSearch = "";
  state.showPastEventos = false;
  state.page = 1;
  saveNav();

  if (unsubEventos)    unsubEventos();
  if (unsubEncerrados) unsubEncerrados();

  function onEventosUpdate() {
    if (state.route !== "curso") return;
    if (root.querySelector("#eventos-content")) {
      cursoEventosPartialUpdate();
    } else {
      render();
    }
  }

  // Futuros: ativo === true
  unsubEventos = listenEventos(cursoId, (eventos) => {
    state.eventos = eventos;
    state.eventosLoaded = true;
    onEventosUpdate();
  });

  // Encerrados: encerrado === true (sempre carregado para exibir o contador)
  unsubEncerrados = listenEncerrados(cursoId, (encerrados) => {
    state.encerrados = encerrados;
    state.encerradosLoaded = true;
    onEventosUpdate();
  });

  render();
}

function goToCurso() {
  if (unsubInscritos) { unsubInscritos(); unsubInscritos = null; }
  state.route = "curso";
  state.evento = null;
  state.inscritos = [];
  state.selectedIds = new Set();
  state.search = "";
  state.filters = { status: "", vendedor: "", variante: "", impresso: "" };
  state.page = 1;
  saveNav();
  render();
}

function openEvento(eventoId) {
  const evento = findEvento(eventoId);
  if (!evento) return;
  state.evento = evento;
  state.route = "evento";
  state.inscritos = [];
  // [fix] reseta a flag de loading — a tabela mostra "carregando" até o próximo snapshot
  state.inscritosLoaded = false;
  state.selectedIds = new Set();
  state.search = "";
  state.filters = { status: "", vendedor: "", variante: "", impresso: "" };
  state.page = 1;
  saveNav();
  if (unsubInscritos) unsubInscritos();
  // [alteração 4] snapshot → partial update; scroll preservado
  unsubInscritos = listenInscritos(state.curso.id, eventoId, (inscritos) => {
    state.inscritos = inscritos;
    state.inscritosLoaded = true;
    if (state.route === "evento") {
      if (root.querySelector("#inscritos-tbody")) {
        const scrollY = document.documentElement.scrollTop || document.body.scrollTop;
        eventoViewPartialUpdate();
        document.documentElement.scrollTop = scrollY;
        document.body.scrollTop = scrollY;
      } else {
        render();
      }
    }
  });
  render();
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────

const EXPORT_HEADERS = [
  "Nome", "Sobrenome", "Email", "Telefone", "Empresa", "CPF",
  "Cidade", "Estado", "Pedido Shopify", "Data Compra",
  "Curso", "Evento", "Variante",
  "Quantidade", "Preço Catálogo", "Desconto Aplicado", "Valor Unitário Pago", "Valor Final Pago",
  "Vendedor", "Status", "Observação", "Impresso"
];

function exportRow(i) {
  const { nome, sobrenome } = splitName(i.cliente);
  const precoCat = i.precoCatalogo ?? i.precoUnitarioPago ?? valorPago(i);
  const desconto  = i.descontoAplicado ?? 0;
  const unitario  = i.valorUnitarioPago ?? valorPago(i);
  const final     = valorPago(i);
  return [
    nome, sobrenome,
    i.email || "", i.telefone || "", i.empresa || "", i.cpf || "",
    i.cidade || "", i.estado || "",
    i.pedido || "",
    formatDate(i.dataCompra),
    state.curso?.nome || "",
    state.evento?.varianteTitle || state.evento?.id || "",
    i.variante || "",
    i.quantidade ?? 1,
    precoCat ? money.format(precoCat) : "0,00",
    desconto  ? money.format(desconto)  : "0,00",
    unitario  ? money.format(unitario)  : "0,00",
    final     ? money.format(final)     : "0,00",
    i.vendedor || "", i.status || "", i.observacao || "",
    i.impresso ? "SIM" : "NÃO"
  ];
}

function _download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportList(rows, suffix, format = "excel") {
  const slug = (state.evento?.varianteTitle || state.evento?.id || "export")
    .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
  const base = `lista-${suffix}-${slug}`;
  if (format === "csv") {
    const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [EXPORT_HEADERS.map(esc).join(","), ...rows.map(i => exportRow(i).map(esc).join(","))];
    _download("﻿" + lines.join("\n"), `${base}.csv`, "text/csv;charset=utf-8");
  } else {
    const lines = [EXPORT_HEADERS.join("\t"), ...rows.map(i => exportRow(i).join("\t"))];
    _download("﻿" + lines.join("\n"), `${base}.xls`, "text/tab-separated-values;charset=utf-8");
  }
}

function exportExcel()       { exportList(filteredInscritos(), "filtrados"); }
function exportCSV()         { exportList(filteredInscritos(), "filtrados", "csv"); }
function exportTudo(fmt)     { exportList([...state.inscritos], "tudo", fmt); }
function exportImpressos()   { exportList(state.inscritos.filter(i => i.impresso), "impressos"); }
function exportPendentes()   { exportList(state.inscritos.filter(i => !i.impresso), "pendentes"); }
function exportSelecionados() {
  const rows = [...state.selectedIds].map(id => state.inscritos.find(i => i.id === id)).filter(Boolean);
  exportList(rows, "selecionados");
}
