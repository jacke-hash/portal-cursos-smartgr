import {
  listenCursos,
  listenEncerrados,
  listenEventos,
  listenInscritos,
  updateInscrito,
} from "../services/firestore.js";
import { formatDate, formatSync, money, statusClass } from "../utils/format.js";

const LOGO = "https://cdn.shopify.com/s/files/1/0727/8480/6045/files/logo_smart_gr_-_azul.svg?v=1773686608";

// [alteração 6] "Cancelado" adicionado; mantida a ordem operacional existente
const STATUSES = [
  "Não Confirmado", "Confirmado", "Presente",
  "Ausente", "Remanejado", "Desistente", "Cancelado", "Reembolsado"
];

const PAGE_SIZE = 25;

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
  filters: { status: "", vendedor: "", variante: "", impresso: "" },
  sortKey: "dataCompra",
  sortDir: "desc",
  page: 1
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
  state.eventoSearch = saved.eventoSearch || "";
  state.showPastEventos = false;
  state.page = 1;

  if (unsubEventos)    unsubEventos();
  if (unsubEncerrados) unsubEncerrados();

  // Encerrados carregados em paralelo para exibir o contador no botão
  unsubEncerrados = listenEncerrados(curso.id, (encerrados) => {
    state.encerrados = encerrados;
    if (state.route === "curso") {
      if (root.querySelector("#eventos-content")) cursoEventosPartialUpdate();
      else render();
    }
  });

  const savedEventoId = saved.eventoId;
  const savedRoute = saved.route;
  const savedScrollY = saved.scrollY || 0;
  let didAttemptEvento = false;

  unsubEventos = listenEventos(curso.id, (eventos) => {
    state.eventos = eventos;

    // [alteração 2] tenta uma única vez restaurar o evento salvo
    if (!didAttemptEvento && savedRoute === "evento" && savedEventoId) {
      didAttemptEvento = true;
      const evento = eventos.find(e => e.id === savedEventoId);
      if (evento) {
        state.search = saved.search || "";
        state.filters = saved.filters || { status: "", vendedor: "", variante: "", impresso: "" };
        state.sortKey = saved.sortKey || "dataCompra";
        state.sortDir = saved.sortDir || "desc";
        state.page = saved.page || 1;
        _restoreOpenEvento(evento, savedScrollY);
        return;
      }
    }

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

  if (unsubInscritos) unsubInscritos();
  unsubInscritos = listenInscritos(state.curso.id, evento.id, (inscritos) => {
    state.inscritos = inscritos;
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
  return state.cursos.filter(c =>
    normalize(c.nome).includes(q) || normalize(c.proximoEventoLabel).includes(q)
  );
}

function courseGridContent() {
  const filtered = filteredCursos();
  return filtered.length ? filtered.map(courseCard).join("") : empty("Nenhum curso encontrado.");
}

function cursosView() {
  return `
    <section class="page-head">
      <div>
        <p class="eyebrow">Portal operacional</p>
        <h1>SMARTGR CURSOS</h1>
      </div>
      <input class="search" data-action="search-cursos" placeholder="Buscar curso..." value="${state.search}">
    </section>
    <section class="course-grid" id="course-grid">
      ${courseGridContent()}
    </section>
  `;
}

function courseCard(curso) {
  const total = curso.totalInscritos || 0;
  const pendentes = curso.credenciaisPendentes || 0;
  return `
    <button class="course-card" data-action="open-curso" data-curso-id="${curso.id}">
      <strong>${curso.nome}</strong>
      <div class="card-meta">
        <span><b>${total}</b> inscritos</span>
        <span>Próximo: <b>${curso.proximoEventoLabel || "--"}</b></span>
        <span>Sync: <b>${formatSync(curso.updatedAt)}</b></span>
        <span class="${pendentes ? "badge-warn" : "badge-ok"}">${pendentes} pendentes</span>
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
  };
}

// [alteração 1] Exibe encerrados apenas quando toggle ativo
function eventoGridContent(sections) {
  const { future, past } = sections;
  let html = future.length
    ? future.map(eventoCard).join("")
    : `<div class="empty" style="grid-column:1/-1">Nenhum evento futuro encontrado.</div>`;

  if (state.showPastEventos && past.length) {
    html += `<div class="encerrados-sep" style="grid-column:1/-1"><span class="encerrados-label">Eventos Encerrados</span></div>`;
    html += past.map(eventoCard).join("");
  }
  return html;
}

function cursoView() {
  if (!state.curso) return empty("Curso não encontrado.");
  const sections = computeEventoSections();
  const { pastCount, futureCount } = sections;

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
      ${pastCount > 0 ? `
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

// [alteração 6] Centraliza cálculo de todos os status operacionais
function inscritosStats() {
  const all = state.inscritos;
  return {
    total: all.length,
    confirmados: all.filter(i => i.status === "Confirmado" || i.status === "Presente").length,
    naoConfirmados: all.filter(i => i.status === "Não Confirmado").length,
    presentes: all.filter(i => i.status === "Presente").length,
    ausentes: all.filter(i => i.status === "Ausente").length,
    desistentes: all.filter(i => i.status === "Desistente").length,
    cancelados: all.filter(i => i.status === "Cancelado").length,
    reembolsados: all.filter(i => i.status === "Reembolsado").length,
    impressos: all.filter(i => i.impresso === true).length,
  };
}

function eventoView() {
  if (!state.evento) return empty("Evento não encontrado.");
  const inscritos = filteredInscritos();
  const paginated = inscritos.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  const totalPages = Math.ceil(inscritos.length / PAGE_SIZE);
  const vendedores = [...new Set(state.inscritos.map(i => i.vendedor).filter(Boolean))];
  const variantes = [...new Set(state.inscritos.map(i => i.variante).filter(Boolean))];
  const variantesFiltradas = new Set(inscritos.map(i => i.variante).filter(Boolean)).size;
  const stats = inscritosStats();

  return `
    <section class="page-head">
      <div>
        <button class="back-btn" data-action="go-curso">← ${state.curso?.nome || "Curso"}</button>
        <h2>${state.evento.varianteTitle || state.evento.id}</h2>
      </div>
      <div class="export-btns">
        <button class="btn-export" data-action="export-excel">Exportar Excel</button>
        <button class="btn-export" data-action="export-csv">Exportar CSV</button>
      </div>
    </section>

    <div class="summary-bar" id="summary-bar">
      ${summaryCard("Participantes", inscritos.length)}
      ${summaryCard("Variantes", variantesFiltradas)}
      ${summaryCard("Impressos", inscritos.filter(i => i.impresso === true).length)}
      ${summaryCard("Pendentes", inscritos.filter(i => !i.impresso).length)}
    </div>

    <div class="stats-bar" id="stats-bar">
      ${statCard("Total geral", stats.total)}
      ${statCard("Confirmados", stats.confirmados)}
      ${statCard("Não confirmados", stats.naoConfirmados)}
      ${statCard("Presentes", stats.presentes)}
      ${statCard("Ausentes", stats.ausentes)}
      ${statCard("Desistentes", stats.desistentes)}
      ${statCard("Cancelados", stats.cancelados)}
      ${statCard("Reembolsados", stats.reembolsados)}
    </div>

    <div class="filters-bar">
      <input class="search" data-action="search" placeholder="Buscar pedido, nome, email, CPF..." value="${state.search}">
      <select data-filter="status">
        <option value="">Todos os status</option>
        ${STATUSES.map(s => `<option value="${s}" ${state.filters.status === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <select data-filter="vendedor">
        <option value="">Todos os vendedores</option>
        ${vendedores.map(v => `<option value="${v}" ${state.filters.vendedor === v ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <select data-filter="variante">
        <option value="">Todas as variantes</option>
        ${variantes.map(v => `<option value="${v}" ${state.filters.variante === v ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <select data-filter="impresso">
        <option value="">Todos</option>
        <option value="true" ${state.filters.impresso === "true" ? "selected" : ""}>Somente Impressos</option>
        <option value="false" ${state.filters.impresso === "false" ? "selected" : ""}>Somente Pendentes</option>
      </select>
      ${hasFilters() ? `<button class="btn-clear" data-action="clear-filters">Limpar filtros</button>` : ""}
    </div>

    <p class="results-count" id="results-count">${inscritos.length} inscritos encontrados</p>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
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
          ${paginated.length
            ? paginated.map(inscritoRow).join("")
            : `<tr><td colspan="12" class="empty-row">Nenhum inscrito encontrado.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div id="pagination-wrap">${totalPages > 1 ? pagination(state.page, totalPages) : ""}</div>
  `;
}

function statCard(label, value) {
  return `<div class="stat-card"><span class="stat-label">${label}</span><b class="stat-value">${value}</b></div>`;
}

function summaryCard(label, value) {
  return `<div class="summary-card"><span class="summary-label">${label}</span><b class="summary-value">${value}</b></div>`;
}

function th(key, label) {
  const active = state.sortKey === key;
  const dir = active ? (state.sortDir === "asc" ? "↑" : "↓") : "";
  return `<th class="sortable ${active ? "sort-active" : ""}" data-sort="${key}">${label} ${dir}</th>`;
}

function inscritoRow(inscrito) {
  const cls = statusClass(inscrito.status || "");
  return `
    <tr data-inscrito-id="${inscrito.id}">
      <td>${inscrito.pedido || "--"}</td>
      <td>${money.format(valorPago(inscrito))}</td>
      <td>${formatDate(inscrito.dataCompra)}</td>
      <td>${inscrito.telefone || "--"}</td>
      <td>${inscrito.cpf || "--"}</td>
      <td>${inscrito.email || "--"}</td>
      <td>${inscrito.cliente || "--"}</td>
      <td>${inscrito.variante || "--"}</td>
      <td>${inscrito.vendedor || "--"}</td>
      <td>
        <select class="status-select status-${cls}" data-action="change-status" data-inscrito-id="${inscrito.id}">
          ${STATUSES.map(s => `<option value="${s}" ${inscrito.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function filteredInscritos() {
  let list = [...state.inscritos];

  if (state.search) {
    const q = normalize(state.search);
    list = list.filter(i =>
      [i.pedido, i.cliente, i.email, i.cpf, i.telefone,
       i.cidade, i.estado, i.variante, formatDate(i.dataCompra)]
        .some(v => normalize(v).includes(q))
    );
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

// ─── PARTIAL UPDATES ─────────────────────────────────────────────────────────
// [alteração 4] Re-render cirúrgico preserva contexto do usuário sem refresh total

function eventoViewPartialUpdate() {
  const inscritos = filteredInscritos();
  const paginated = inscritos.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  const totalPages = Math.ceil(inscritos.length / PAGE_SIZE);
  const variantesFiltradas = new Set(inscritos.map(i => i.variante).filter(Boolean)).size;
  const stats = inscritosStats();

  const summaryBar     = root.querySelector("#summary-bar");
  const statsBar       = root.querySelector("#stats-bar");
  const resultsCount   = root.querySelector("#results-count");
  const tbody          = root.querySelector("#inscritos-tbody");
  const paginationWrap = root.querySelector("#pagination-wrap");

  if (summaryBar) summaryBar.innerHTML =
    summaryCard("Participantes", inscritos.length) +
    summaryCard("Variantes", variantesFiltradas) +
    summaryCard("Impressos", inscritos.filter(i => i.impresso === true).length) +
    summaryCard("Pendentes", inscritos.filter(i => !i.impresso).length);

  // [alteração 6] Cancelados e Reembolsados agora aparecem nas stats
  if (statsBar) statsBar.innerHTML =
    statCard("Total geral", stats.total) +
    statCard("Confirmados", stats.confirmados) +
    statCard("Não confirmados", stats.naoConfirmados) +
    statCard("Presentes", stats.presentes) +
    statCard("Ausentes", stats.ausentes) +
    statCard("Desistentes", stats.desistentes) +
    statCard("Cancelados", stats.cancelados) +
    statCard("Reembolsados", stats.reembolsados);

  if (resultsCount) resultsCount.textContent = `${inscritos.length} inscritos encontrados`;

  if (tbody) tbody.innerHTML = paginated.length
    ? paginated.map(inscritoRow).join("")
    : `<tr><td colspan="12" class="empty-row">Nenhum inscrito encontrado.</td></tr>`;

  if (paginationWrap) paginationWrap.innerHTML = totalPages > 1 ? pagination(state.page, totalPages) : "";
}

function cursoEventosPartialUpdate() {
  const sections = computeEventoSections();
  const { pastCount, futureCount } = sections;

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
  if (pastCount > 0 && !toggleBtn) render();
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
      state.filters = { status: "", vendedor: "", variante: "", impresso: "" };
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
    onEventosUpdate();
  });

  // Encerrados: encerrado === true (sempre carregado para exibir o contador)
  unsubEncerrados = listenEncerrados(cursoId, (encerrados) => {
    state.encerrados = encerrados;
    onEventosUpdate();
  });

  render();
}

function goToCurso() {
  if (unsubInscritos) { unsubInscritos(); unsubInscritos = null; }
  state.route = "curso";
  state.evento = null;
  state.inscritos = [];
  state.search = "";
  state.filters = { status: "", vendedor: "", variante: "", impresso: "" };
  state.page = 1;
  saveNav();
  render();
}

function openEvento(eventoId) {
  const evento = state.eventos.find(e => e.id === eventoId);
  if (!evento) return;
  state.evento = evento;
  state.route = "evento";
  state.inscritos = [];
  state.search = "";
  state.filters = { status: "", vendedor: "", variante: "", impresso: "" };
  state.page = 1;
  saveNav();
  if (unsubInscritos) unsubInscritos();
  // [alteração 4] snapshot → partial update; scroll preservado
  unsubInscritos = listenInscritos(state.curso.id, eventoId, (inscritos) => {
    state.inscritos = inscritos;
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

function exportExcel() {
  const rows = filteredInscritos();
  const lines = [EXPORT_HEADERS.join("\t"), ...rows.map(i => exportRow(i).join("\t"))];
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/tab-separated-values;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lista-presenca-${state.evento?.varianteTitle || state.evento?.id || "export"}.xls`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCSV() {
  const rows = filteredInscritos();
  const escape = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [EXPORT_HEADERS.map(escape).join(","), ...rows.map(i => exportRow(i).map(escape).join(","))];
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lista-presenca-${state.evento?.varianteTitle || state.evento?.id || "export"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
