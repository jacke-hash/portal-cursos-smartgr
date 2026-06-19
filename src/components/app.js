import {
  listenCursos,
  listenEventos,
  listenInscritos,
  updateInscrito
} from "../services/firestore.js";
import { formatDate, formatShortDate, formatSync, money, statusClass } from "../utils/format.js";

const LOGO = "https://cdn.shopify.com/s/files/1/0727/8480/6045/files/logo_smart_gr_-_azul.svg?v=1773686608";

const STATUSES = ["Não Confirmado", "Confirmado", "Presente", "Ausente", "Remanejado", "Desistente", "Reembolsado"];

const PRODUTOS = {
  "8821788115101": "Treinamento Prático - Prisma Peeling",
  "8821788180637": "Treinamento Presencial - Protocolo Peptídeos",
  "8701283827869": "Terapias Médicas Baseadas em Eletroporação",
  "8680458551453": "Treinamento Presencial de Microagulhamento",
  "8955598438557": "Presencial - Pocket Microagulhamento",
  "8695759601821": "SMART DAY",
  "8928830193821": "8° Congresso"
};

const PAGE_SIZE = 25;

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

let state = {
  route: "cursos",
  cursos: [],
  eventos: [],
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

let unsubCursos = null;
let unsubEventos = null;
let unsubInscritos = null;
let root;

export function renderApp(target) {
  root = target;
  root.innerHTML = shell();
  bindGlobalEvents();
  unsubCursos = listenCursos((cursos) => {
    state.cursos = cursos;
    render();
  });
  render();
}

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

function render() {
  const view = root.querySelector("#view");
  if (state.route === "cursos") view.innerHTML = cursosView();
  if (state.route === "curso") view.innerHTML = cursoView();
  if (state.route === "evento") view.innerHTML = eventoView();
  bindDynamicEvents();
}

// ─── VIEWS ───────────────────────────────────────────────────────────────────

function filteredCursos() {
  if (!state.search) return state.cursos;
  const q = state.search.toLowerCase();
  return state.cursos.filter((c) =>
    (c.nome || "").toLowerCase().includes(q) ||
    (c.proximoEventoLabel || "").toLowerCase().includes(q)
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

function cursoView() {
  if (!state.curso) return empty("Curso não encontrado.");

  const agora = new Date();

  // 1. Ordenar cronologicamente (null = sem data → vai para o final)
  const sorted = [...state.eventos].sort((a, b) => {
    const da = a.data?.toDate?.() ?? null;
    const db = b.data?.toDate?.() ?? null;
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da - db;
  });

  // 2. Contar futuros e passados (para cards resumo e botão toggle)
  const pastCount = sorted.filter(e => {
    const d = e.data?.toDate?.() ?? null;
    return d !== null && d < agora;
  }).length;
  const futureCount = sorted.length - pastCount;

  // 3. Filtrar eventos passados (a menos que toggle esteja ativo)
  let visibles = state.showPastEventos
    ? sorted
    : sorted.filter(e => {
        const d = e.data?.toDate?.() ?? null;
        return d === null || d >= agora;  // sem data = sempre visível
      });

  // 4. Filtrar por busca
  const q = state.eventoSearch.toLowerCase().trim();
  if (q) {
    visibles = visibles.filter(e =>
      (e.varianteTitle || "").toLowerCase().includes(q)
    );
  }

  return `
    <section class="page-head">
      <div>
        <button class="back-btn" data-action="go-cursos">← Cursos</button>
        <h2>${state.curso.nome}</h2>
      </div>
    </section>
    <div class="stats-bar">
      ${statCard("Eventos futuros", futureCount)}
      ${statCard("Eventos encerrados", pastCount)}
    </div>
    <div class="eventos-toolbar">
      <input class="search" data-action="search-evento"
             placeholder="🔍 Buscar evento..." value="${state.eventoSearch}">
      ${pastCount > 0 ? `
        <button class="btn-toggle-past ${state.showPastEventos ? "active" : ""}"
                data-action="toggle-past-eventos">
          ${state.showPastEventos
            ? "Ocultar eventos encerrados"
            : `Mostrar encerrados (${pastCount})`}
        </button>` : ""}
    </div>
    <section class="eventos-grid">
      ${visibles.length ? visibles.map(eventoCard).join("") : empty("Nenhum evento encontrado.")}
    </section>
  `;
}

function eventoCard(evento) {
  const agora = new Date();
  // data real do evento: Firestore Timestamp → Date
  const evDate = evento.data?.toDate?.() ?? null;
  const isPast = evDate !== null && evDate < agora;

  const dateLabel = evDate
    ? evDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "";

  // Badge de status: visível apenas quando histórico está ativo (mistura de futuros e passados)
  const statusBadge = state.showPastEventos && evDate
    ? `<span class="evento-status ${isPast ? "evento-status-encerrado" : "evento-status-proximo"}">
        ${isPast ? "Encerrado" : "Próximo Evento"}
       </span>`
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

function eventoView() {
  if (!state.evento) return empty("Evento não encontrado.");
  const inscritos = filteredInscritos();
  const paginated = inscritos.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  const totalPages = Math.ceil(inscritos.length / PAGE_SIZE);
  const vendedores = [...new Set(state.inscritos.map((i) => i.vendedor).filter(Boolean))];
  const variantes = [...new Set(state.inscritos.map((i) => i.variante).filter(Boolean))];

  const variantesFiltradas = new Set(inscritos.map((i) => i.variante).filter(Boolean)).size;

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

    <div class="summary-bar">
      ${summaryCard("Participantes", inscritos.length)}
      ${summaryCard("Variantes", variantesFiltradas)}
      ${summaryCard("Impressos", inscritos.filter(i => i.impresso === true).length)}
      ${summaryCard("Pendentes", inscritos.filter(i => !i.impresso).length)}
    </div>

    <div class="stats-bar">
      ${statCard("Total geral", state.inscritos.length)}
      ${statCard("Confirmados", state.inscritos.filter((i) => i.status === "Confirmado" || i.status === "Presente").length)}
      ${statCard("Não confirmados", state.inscritos.filter((i) => i.status === "Não Confirmado").length)}
      ${statCard("Presentes", state.inscritos.filter((i) => i.status === "Presente").length)}
      ${statCard("Ausentes", state.inscritos.filter((i) => i.status === "Ausente").length)}
      ${statCard("Desistentes", state.inscritos.filter((i) => i.status === "Desistente").length)}
    </div>

    <div class="filters-bar">
      <input class="search" data-action="search" placeholder="Buscar pedido, nome, email, CPF..." value="${state.search}">
      <select data-filter="status">
        <option value="">Todos os status</option>
        ${STATUSES.map((s) => `<option value="${s}" ${state.filters.status === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <select data-filter="vendedor">
        <option value="">Todos os vendedores</option>
        ${vendedores.map((v) => `<option value="${v}" ${state.filters.vendedor === v ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <select data-filter="variante">
        <option value="">Todas as variantes</option>
        ${variantes.map((v) => `<option value="${v}" ${state.filters.variante === v ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <select data-filter="impresso">
        <option value="">Todos</option>
        <option value="true" ${state.filters.impresso === "true" ? "selected" : ""}>Somente Impressos</option>
        <option value="false" ${state.filters.impresso === "false" ? "selected" : ""}>Somente Pendentes</option>
      </select>
      ${hasFilters() ? `<button class="btn-clear" data-action="clear-filters">Limpar filtros</button>` : ""}
    </div>

    <p class="results-count">${inscritos.length} inscritos encontrados</p>

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
        <tbody>
          ${paginated.length ? paginated.map(inscritoRow).join("") : `<tr><td colspan="12" class="empty-row">Nenhum inscrito encontrado.</td></tr>`}
        </tbody>
      </table>
    </div>

    ${totalPages > 1 ? pagination(state.page, totalPages) : ""}
  `;
}

function statCard(label, value) {
  return `<div class="stat-card"><span class="stat-label">${label}</span><b class="stat-value">${value}</b></div>`;
}

function summaryCard(label, value) {
  return `<div class="summary-card"><span class="summary-label">${label}</span><b class="summary-value">${value}</b></div>`;
}

function splitName(fullName) {
  if (!fullName) return { nome: "", sobrenome: "" };
  const parts = fullName.trim().split(" ");
  return { nome: parts[0] || "", sobrenome: parts.slice(1).join(" ") || "" };
}

// Prioridade: valorFinalPago (novo) → valorLiquidoPago (anterior) → valor (legado)
function valorPago(inscrito) {
  return inscrito.valorFinalPago ?? inscrito.valorLiquidoPago ?? inscrito.valor ?? 0;
}

function th(key, label) {
  const active = state.sortKey === key;
  const dir = active ? (state.sortDir === "asc" ? "↑" : "↓") : "";
  return `<th class="sortable ${active ? "sort-active" : ""}" data-sort="${key}">${label} ${dir}</th>`;
}

function inscritoRow(inscrito) {
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
        <select class="status-select status-${statusClass(inscrito.status || "")}" data-action="change-status" data-inscrito-id="${inscrito.id}">
          ${STATUSES.map((s) => `<option value="${s}" ${inscrito.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </td>
      <td>
        <input class="note" placeholder="Adicionar observação..." value="${inscrito.observacao || ""}" data-action="change-obs" data-inscrito-id="${inscrito.id}">
      </td>
      <td>
        <button class="impresso-btn${inscrito.impresso ? ' ativo' : ''}" data-action="toggle-impresso" data-inscrito-id="${inscrito.id}">
          ${inscrito.impresso ? '☑ Impresso' : '☐ Pendente'}
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
    const q = state.search.toLowerCase();
    list = list.filter((i) =>
      [i.pedido, i.cliente, i.email, i.cpf, i.telefone]
        .some((v) => v && v.toLowerCase().includes(q))
    );
  }

  if (state.filters.status) list = list.filter((i) => i.status === state.filters.status);
  if (state.filters.vendedor) list = list.filter((i) => i.vendedor === state.filters.vendedor);
  if (state.filters.variante) list = list.filter((i) => i.variante === state.filters.variante);
  if (state.filters.impresso === "true") list = list.filter((i) => i.impresso === true);
  if (state.filters.impresso === "false") list = list.filter((i) => !i.impresso);

  list.sort((a, b) => {
    // Coluna "Valor Pago" usa valorPago() para ler o campo correto independente da versão do doc
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

// ─── EVENTS ──────────────────────────────────────────────────────────────────

function handleClick(e) {
  const el = e.target.closest("[data-action]");
  if (!el) return;
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
    render();
  } else if (action === "prev-page") {
    state.page--;
    render();
  } else if (action === "next-page") {
    state.page++;
    render();
  } else if (action === "toggle-past-eventos") {
    state.showPastEventos = !state.showPastEventos;
    render();
  } else if (action === "toggle-impresso") {
    const id = el.dataset.inscritoId;
    const inscrito = state.inscritos.find((i) => i.id === id);
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
    render();
  }
}

const _debouncedCursoSearch = debounce(() => {
  const grid = root.querySelector("#course-grid");
  if (grid) grid.innerHTML = courseGridContent();
}, 200);

function handleInput(e) {
  if (e.target.dataset.action === "search-cursos") {
    state.search = e.target.value;
    _debouncedCursoSearch();
    return;
  }

  if (e.target.dataset.action === "search") {
    state.search = e.target.value;
    state.page = 1;
    render();
  }

  if (e.target.dataset.action === "search-evento") {
    state.eventoSearch = e.target.value;
    render();
  }

  if (e.target.dataset.action === "change-obs") {
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
    render();
  }

  if (e.target.dataset.action === "change-status") {
    const id = e.target.dataset.inscritoId;
    updateInscrito(state.curso.id, state.evento.id, id, { status: e.target.value });
  }
}

function bindDynamicEvents() {
  // eventos já vinculados via delegação no root
}

// ─── NAVEGAÇÃO ────────────────────────────────────────────────────────────────

function goToCursos() {
  if (unsubEventos) { unsubEventos(); unsubEventos = null; }
  if (unsubInscritos) { unsubInscritos(); unsubInscritos = null; }
  state.route = "cursos";
  state.curso = null;
  state.evento = null;
  state.eventos = [];
  state.inscritos = [];
  state.search = "";
  state.eventoSearch = "";
  state.showPastEventos = false;
  state.filters = { status: "", vendedor: "", variante: "", impresso: "" };
  state.page = 1;
  render();
}

function openCurso(cursoId) {
  const curso = state.cursos.find((c) => c.id === cursoId);
  if (!curso) return;
  state.curso = curso;
  state.route = "curso";
  state.eventos = [];
  state.search = "";
  state.eventoSearch = "";
  state.showPastEventos = false;
  state.page = 1;
  if (unsubEventos) unsubEventos();
  unsubEventos = listenEventos(cursoId, (eventos) => {
    state.eventos = eventos;
    render();
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
  render();
}

function openEvento(eventoId) {
  const evento = state.eventos.find((e) => e.id === eventoId);
  if (!evento) return;
  state.evento = evento;
  state.route = "evento";
  state.inscritos = [];
  state.search = "";
  state.filters = { status: "", vendedor: "", variante: "", impresso: "" };
  state.page = 1;
  if (unsubInscritos) unsubInscritos();
  unsubInscritos = listenInscritos(state.curso.id, eventoId, (inscritos) => {
    state.inscritos = inscritos;
    render();
  });
  render();
}

// ─── EXPORT EXCEL ─────────────────────────────────────────────────────────────

const EXPORT_HEADERS = [
  "Nome", "Sobrenome", "Email", "Telefone", "Empresa", "CPF",
  "Cidade", "Estado", "Pedido Shopify", "Data Compra",
  "Curso", "Evento", "Variante",
  "Quantidade", "Preço Catálogo", "Desconto Aplicado", "Valor Unitário Pago", "Valor Final Pago",
  "Vendedor", "Status", "Observação", "Impresso"
];

function exportRow(i) {
  const { nome, sobrenome } = splitName(i.cliente);
  const precoCat  = i.precoCatalogo ?? i.precoUnitarioPago ?? (valorPago(i));
  const desconto  = i.descontoAplicado ?? 0;
  const unitario  = i.valorUnitarioPago ?? valorPago(i);
  const final     = valorPago(i);
  return [
    nome,
    sobrenome,
    i.email || "",
    i.telefone || "",
    i.empresa || "",
    i.cpf || "",
    i.cidade || "",
    i.estado || "",
    i.pedido || "",
    formatDate(i.dataCompra),
    state.curso?.nome || "",
    state.evento?.varianteTitle || state.evento?.id || "",
    i.variante || "",
    i.quantidade ?? 1,
    precoCat  ? money.format(precoCat)  : "0,00",
    desconto  ? money.format(desconto)  : "0,00",
    unitario  ? money.format(unitario)  : "0,00",
    final     ? money.format(final)     : "0,00",
    i.vendedor || "",
    i.status || "",
    i.observacao || "",
    i.impresso ? "SIM" : "NÃO"
  ];
}

function exportExcel() {
  const rows = filteredInscritos();
  const lines = [
    EXPORT_HEADERS.join("\t"),
    ...rows.map((i) => exportRow(i).join("\t"))
  ];
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
  const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [
    EXPORT_HEADERS.map(escape).join(","),
    ...rows.map((i) => exportRow(i).map(escape).join(","))
  ];
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lista-presenca-${state.evento?.varianteTitle || state.evento?.id || "export"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}