import {
  getInscritosConfirmados,
  listenCursos,
  listenEncerrados,
  listenEventos,
  listenInscritos,
  updateCurso,
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

// Única fonte de verdade do "filtro zerado" de inscritos — reusada em todo
// ponto que reseta state.filters. Antes, esse literal era repetido em 6
// lugares e 3 deles esqueciam a chave `inativos`, deixando o filtro de
// inativos num estado inconsistente após certas navegações.
const DEFAULT_INSCRITO_FILTERS = Object.freeze({
  status: "", vendedor: "", variante: "", impresso: "", inativos: "", valor: "",
});

// Direção padrão ao trocar a chave de ordenação dos cursos — cada opção já
// "promete" uma direção pelo próprio nome (ex.: "Mais inscritos" = decrescente).
const CURSO_SORT_DEFAULT_DIR = { nome: "asc", totalInscritos: "desc", updatedAt: "desc" };

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

// ─── STATUS DE CURSO (arquivamento/ocultação) ─────────────────────────────────
// Única fonte de verdade sobre visibilidade/aparência de cursos por status.
// Toda a UI (menu do card, filtros, badge, opacidade) deriva daqui — nenhuma
// outra parte do código deve comparar `curso.status` diretamente.
const CURSO_STATUS = {
  ACTIVE:   "active",
  HIDDEN:   "hidden",
  FINISHED: "finished",
  DRAFT:    "draft",
};

// `toggleKey` aponta para o campo em `state` que controla a exibição desse
// status na listagem (null = sempre visível). Adicionar um status novo no
// futuro é só acrescentar uma entrada aqui (e, se precisar de filtro próprio,
// um novo toggle em `state` + checkbox em cursosView).
const CURSO_STATUS_CONFIG = {
  [CURSO_STATUS.ACTIVE]:   { badge: null,        cardClass: "",                       toggleKey: null },
  [CURSO_STATUS.HIDDEN]:   { badge: "OCULTO",    cardClass: "course-card--hidden",     toggleKey: "showHiddenCursos" },
  [CURSO_STATUS.FINISHED]: { badge: "ENCERRADO", cardClass: "course-card--finished",   toggleKey: "showFinishedCursos" },
  // Rascunho ainda não tem ação própria na UI — por ora fica atrás do mesmo
  // toggle de "ocultos", já que também não deve aparecer na listagem padrão.
  [CURSO_STATUS.DRAFT]:    { badge: "RASCUNHO",  cardClass: "course-card--hidden",     toggleKey: "showHiddenCursos" },
};

// Retrocompatibilidade: cursos gravados antes desta feature não têm o campo
// `status` no Firestore — tratamos como "active" sem nunca escrever nada no banco.
function getCursoStatus(curso) {
  return CURSO_STATUS_CONFIG[curso?.status] ? curso.status : CURSO_STATUS.ACTIVE;
}

function cursoStatusConfig(curso) {
  return CURSO_STATUS_CONFIG[getCursoStatus(curso)];
}

function isCursoVisivelNaListagem(curso) {
  const toggleKey = cursoStatusConfig(curso).toggleKey;
  return !toggleKey || !!state[toggleKey];
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
      showHiddenCursos: state.showHiddenCursos,
      showFinishedCursos: state.showFinishedCursos,
      cursoSortKey: state.cursoSortKey,
      cursoSortDir: state.cursoSortDir,
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
  showHiddenCursos: false,   // filtro "Mostrar cursos ocultos" na Relação de Inscritos
  showFinishedCursos: false, // filtro "Mostrar cursos encerrados" na Relação de Inscritos
  cursoSortKey: "nome",      // ordenação da listagem de cursos: nome | totalInscritos | updatedAt
  cursoSortDir: "asc",
  filters: { ...DEFAULT_INSCRITO_FILTERS },
  sortKey: "dataCompra",
  sortDir: "desc",
  page: 1,
  selectedIds: new Set(),   // seleção manual de inscritos (bulk actions)
  // Painéis de estatística do evento (público, vendedores, região): modo de
  // gráfico (bar/donut) e expansão da lista, por grupo.
  statsView: {
    profissional: { chart: "bar", expanded: false },
    estudante:    { chart: "bar", expanded: false },
    publico:      { chart: "bar", expanded: false },
    vendedores:   { chart: "bar", expanded: false },
    estado:       { chart: "bar", expanded: false },
    cidade:       { chart: "bar", expanded: false },
  },
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
    if (saved?.showHiddenCursos)   state.showHiddenCursos = true;
    if (saved?.showFinishedCursos) state.showFinishedCursos = true;
    if (saved?.cursoSortKey) state.cursoSortKey = saved.cursoSortKey;
    if (saved?.cursoSortDir) state.cursoSortDir = saved.cursoSortDir;
    const filtrosRow = root.querySelector("#cursos-filtros-row");
    if (filtrosRow) filtrosRow.innerHTML = cursosFiltrosRow();
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
      state.filters = { ...DEFAULT_INSCRITO_FILTERS, ...(saved.filters || {}) };
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
  // Fecha qualquer menu <details> (⋮ do curso, dropdown de exportar) ao
  // clicar fora dele — <details> nativo só fecha reclicando no <summary>.
  root.addEventListener("click", closeOpenDetailsOnOutsideClick);
}

function closeOpenDetailsOnOutsideClick(e) {
  root.querySelectorAll("details[open]").forEach((d) => {
    if (!d.contains(e.target)) d.removeAttribute("open");
  });
}

// [alteração 8] removido bindDynamicEvents() vazio — era chamada morta
function render() {
  const scrollY = document.documentElement.scrollTop || document.body.scrollTop;
  const view = root.querySelector("#view");
  if (state.route === "cursos") view.innerHTML = cursosView();
  else if (state.route === "curso") {
    const sections = computeEventoSections();
    view.innerHTML = cursoView();
    hydrateConfirmados(visibleEventosParaConfirmados(sections));
  }
  else if (state.route === "evento") view.innerHTML = eventoView();
  document.documentElement.scrollTop = scrollY;
  document.body.scrollTop = scrollY;
}

// ─── VIEWS ───────────────────────────────────────────────────────────────────

function filteredCursos() {
  let list = state.cursos.filter(isCursoVisivelNaListagem);
  if (state.search) {
    const q = normalize(state.search);
    list = list.filter(c => normalize(c.nome).includes(q));
  }
  return sortCursos(list);
}

function sortCursos(list) {
  const key = state.cursoSortKey;
  const dir = state.cursoSortDir;
  return [...list].sort((a, b) => {
    let av, bv;
    if (key === "totalInscritos") {
      av = a.totalInscritos || 0;
      bv = b.totalInscritos || 0;
    } else if (key === "updatedAt") {
      av = a.updatedAt?.toDate?.() || new Date(0);
      bv = b.updatedAt?.toDate?.() || new Date(0);
    } else {
      av = normalize(a.nome);
      bv = normalize(b.nome);
    }
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  });
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
    <div class="cursos-filtros-row" id="cursos-filtros-row">
      ${cursosFiltrosRow()}
    </div>
    <section class="course-grid" id="course-grid">
      ${courseGridContent()}
    </section>
  `;
}

function cursosFiltrosRow() {
  return `
    <label class="curso-filter-check">
      <input type="checkbox" data-curso-filter="hidden" ${state.showHiddenCursos ? "checked" : ""}>
      Mostrar cursos ocultos
    </label>
    <label class="curso-filter-check">
      <input type="checkbox" data-curso-filter="finished" ${state.showFinishedCursos ? "checked" : ""}>
      Mostrar cursos encerrados
    </label>
    <div class="curso-sort-wrap">
      <select class="filter-select" data-curso-sort-key>
        <option value="nome" ${state.cursoSortKey === "nome" ? "selected" : ""}>Ordem alfabética</option>
        <option value="totalInscritos" ${state.cursoSortKey === "totalInscritos" ? "selected" : ""}>Mais inscritos</option>
        <option value="updatedAt" ${state.cursoSortKey === "updatedAt" ? "selected" : ""}>Última atualização</option>
      </select>
      <button class="btn-toggle-past btn-toggle-past--icon" data-action="toggle-curso-sort-dir" title="Inverter ordem">
        ${state.cursoSortDir === "asc" ? "↑" : "↓"}
      </button>
    </div>
  `;
}

function courseCard(curso) {
  const cfg = cursoStatusConfig(curso);
  const totalInscritos = curso.totalInscritos || 0;
  // totalEventos só existe em cursos já recalculados pelo worker/sync depois
  // desta melhoria — omite a linha em vez de arriscar mostrar "0" errado
  // para cursos antigos que já têm eventos mas ainda não foram recontados.
  const totalEventos = curso.totalEventos;
  return `
    <div class="course-card${cfg.cardClass ? " " + cfg.cardClass : ""}">
      <button class="course-card-main" data-action="open-curso" data-curso-id="${curso.id}">
        <div class="course-card-body">
          <strong class="course-name">${curso.nome}</strong>
          <div class="course-card-stats">
            <div class="course-card-stat">
              <span class="course-card-stat-value">${totalInscritos}</span>
              <span class="course-card-stat-label">inscrito${totalInscritos !== 1 ? "s" : ""}</span>
            </div>
            ${totalEventos !== undefined ? `
            <div class="course-card-stat">
              <span class="course-card-stat-value">${totalEventos}</span>
              <span class="course-card-stat-label">evento${totalEventos !== 1 ? "s" : ""}</span>
            </div>` : ""}
          </div>
        </div>
        <div class="card-footer">
          <div class="card-footer-info">
            <span class="card-updated-label">Atualizado em</span>
            <span class="card-updated-value">${formatSync(curso.updatedAt)}</span>
          </div>
          <span class="card-footer-hint">Ver turmas →</span>
        </div>
      </button>
      ${cfg.badge ? `<span class="curso-status-badge">${cfg.badge}</span>` : ""}
      ${cursoMenu(curso)}
    </div>
  `;
}

function cursoMenu(curso) {
  return `
    <details class="curso-menu">
      <summary class="curso-menu-btn" title="Mais opções">⋮</summary>
      <div class="curso-menu-dropdown">
        <button class="dd-item" data-action="curso-ocultar" data-curso-id="${curso.id}">Ocultar curso</button>
        <button class="dd-item" data-action="curso-encerrar" data-curso-id="${curso.id}">Marcar como encerrado</button>
        <button class="dd-item" data-action="curso-reativar" data-curso-id="${curso.id}">Reativar curso</button>
      </div>
    </details>
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

// Cache em memória de "confirmados" por evento — o card não lê mais o campo agregado
// do doc do evento (ficava desatualizado quando o status mudava pelo roster, sem trigger
// nenhum recalculando o agregado). Guarda o valor já calculado para não reconsultar o
// Firestore a cada re-render; é invalidado nos pontos onde o status de um inscrito muda.
const _confirmadosCache = new Map(); // eventoId -> count

async function fetchConfirmadosCount(cursoId, eventoId) {
  const docs = await getInscritosConfirmados(cursoId, eventoId);
  return docs.filter(isInscritoAtivo).length;
}

// Eventos que precisam ter "confirmados" calculado para a seção atualmente visível
// (futuros sempre; encerrados só quando o toggle "Mostrar encerrados" está aberto).
function visibleEventosParaConfirmados(sections) {
  const { future, past, sempreExibirEncerrados } = sections;
  return (state.showPastEventos || sempreExibirEncerrados) ? [...future, ...past] : future;
}

// Busca "confirmados" em paralelo só para os eventos ainda não cacheados e atualiza o
// card correspondente assim que cada resposta chega — não bloqueia a renderização inicial.
function hydrateConfirmados(eventos) {
  const pendentes = eventos.filter(ev => !_confirmadosCache.has(ev.id));
  pendentes.forEach(ev => {
    fetchConfirmadosCount(state.curso.id, ev.id)
      .then(count => {
        _confirmadosCache.set(ev.id, count);
        const el = root.querySelector(`[data-confirmados-for="${CSS.escape(ev.id)}"]`);
        if (el) el.textContent = count;
      })
      .catch(() => {}); // falha silenciosa: mantém "…"; próxima hidratação tenta de novo
  });
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
        <span><b data-confirmados-for="${evento.id}">${_confirmadosCache.has(evento.id) ? _confirmadosCache.get(evento.id) : "…"}</b> confirmados</span>
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

// Profissão/área de estudo vêm da Shopify como slug cru (ex.: "biomedico",
// "estetica_cosmetica") — mapeia pros nomes conhecidos com acento e
// maiúscula certos; valor desconhecido cai num title-case genérico.
const FORMACAO_LABELS = {
  biomedico: "Biomédico", esteticista: "Esteticista", enfermeiro: "Enfermeiro",
  dentista: "Dentista", medico: "Médico", farmaceutico: "Farmacêutico",
  fisioterapeuta: "Fisioterapeuta", massoterapeuta: "Massoterapeuta",
  tricologista: "Tricologista", nutricionista: "Nutricionista",
  biomedicina: "Biomedicina", estetica_cosmetica: "Estética e Cosmética",
  odontologia: "Odontologia", farmacia: "Farmácia", enfermagem: "Enfermagem",
  fisioterapia: "Fisioterapia", medicina: "Medicina", nutricao: "Nutrição",
  outras: "Outras", outros: "Outros",
};
function _humanizeFormacao(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (FORMACAO_LABELS[key]) return FORMACAO_LABELS[key];
  if (!key) return raw;
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Painel executivo: conta ingressos (quantidade) e não apenas pedidos.
function eventoInsights() {
  const ativos = state.inscritos.filter(isInscritoAtivo);
  const quantidade = (i) => Math.max(1, Number(i.quantidade) || 1);
  const somaQuantidade = (lista) => lista.reduce((total, i) => total + quantidade(i), 0);
  const agrupar = (lista, campo, vazio) => {
    const grupos = new Map();
    lista.forEach((i) => {
      const nome = String(i[campo] || vazio).trim() || vazio;
      grupos.set(nome, (grupos.get(nome) || 0) + quantidade(i));
    });
    return [...grupos.entries()]
      .map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, "pt-BR"));
  };
  const agruparFormacao = (lista, vazio) =>
    agrupar(lista, "formacao", vazio).map((g) => (g.nome === vazio ? g : { ...g, nome: _humanizeFormacao(g.nome) }));

  // Público separado por perfil: profissional (por profissão) e estudante
  // (por área de estudo) têm distribuição própria; consumidor final e os
  // pedidos antigos sem perfil_cliente (legado) são só uma contagem.
  const profissionais = ativos.filter((i) => i.perfil === "profissional");
  const estudantes    = ativos.filter((i) => i.perfil === "estudante");
  const consumidores  = ativos.filter((i) => i.perfil === "consumidor");
  const semPerfil     = ativos.filter((i) => !["profissional", "estudante", "consumidor"].includes(i.perfil));

  const vendedores = agrupar(ativos, "vendedor", "Venda direta");
  const estados = agrupar(ativos, "estado", "Não informado");
  const cidades = agrupar(ativos, "cidade", "Não informado");

  const publicoTotais = {
    profissional: somaQuantidade(profissionais),
    estudante:    somaQuantidade(estudantes),
    consumidor:   somaQuantidade(consumidores),
    semPerfil:    somaQuantidade(semPerfil),
  };
  const publicoOverview = [
    { nome: "Profissional", total: publicoTotais.profissional },
    { nome: "Estudante", total: publicoTotais.estudante },
    { nome: "Consumidor final", total: publicoTotais.consumidor },
    ...(publicoTotais.semPerfil ? [{ nome: "Não informado", total: publicoTotais.semPerfil }] : []),
  ].filter((g) => g.total > 0).sort((a, b) => b.total - a.total);

  return {
    ingressos: somaQuantidade(ativos),
    publico: {
      profissional: { total: publicoTotais.profissional, formacoes: agruparFormacao(profissionais, "Não informada") },
      estudante:    { total: publicoTotais.estudante, formacoes: agruparFormacao(estudantes, "Não informada") },
      consumidor:   { total: publicoTotais.consumidor },
      semPerfil:    { total: publicoTotais.semPerfil },
      overview:     publicoOverview,
    },
    vendedores,
    regiao: { estados, cidades },
  };
}

const AUDIENCE_PALETTE = ["#173f70", "#3b6ea5", "#5c7ca3", "#7fa0c9", "#9dc0dd", "#c3d8ea", "#8a99ab"];

const _pctChip = (pct) => `<span class="pct-chip">${pct}%</span>`;
const _statCount = (n) => `<span class="stat-count">${n}</span>`;

function _donutChart(grupo) {
  const top = grupo.slice(0, 6);
  const restante = grupo.slice(6).reduce((soma, item) => soma + item.total, 0);
  const items = restante > 0 ? [...top, { nome: "Outras", total: restante }] : top;
  const totalGeral = items.reduce((soma, item) => soma + item.total, 0) || 1;

  let acumulado = 0;
  const stops = items.map((item, idx) => {
    const inicio = (acumulado / totalGeral) * 360;
    acumulado += item.total;
    const fim = (acumulado / totalGeral) * 360;
    return `${AUDIENCE_PALETTE[idx % AUDIENCE_PALETTE.length]} ${inicio}deg ${fim}deg`;
  }).join(", ");

  const legenda = items.map((item, idx) => {
    const pct = totalGeral ? Math.round((item.total / totalGeral) * 100) : 0;
    return `
    <div class="donut-legend-row">
      <span class="donut-swatch" style="background:${AUDIENCE_PALETTE[idx % AUDIENCE_PALETTE.length]}"></span>
      <span title="${item.nome}">${item.nome}</span>
      <b>${_statCount(item.total)}${_pctChip(pct)}</b>
    </div>`;
  }).join("");

  return items.length
    ? `<div class="donut-wrap"><div class="donut-chart" style="background: conic-gradient(${stops})"></div><div class="donut-legend">${legenda}</div></div>`
    : `<span class="event-empty-data">Sem dados</span>`;
}

// Painel genérico de estatística (lista com % + barra, ou rosca), reusado
// pelo público por perfil/formação, vendedores e região (estado/cidade).
// `pctBase`, quando informado, mostra no cabeçalho a % do grupo sobre esse
// total geral (ex.: profissionais são 40% de todos os ingressos); sem ele,
// o cabeçalho mostra só a contagem — usado quando o grupo já cobre 100% do
// evento (vendedores, região, visão geral de público).
function _statGroup(label, grupoKey, grupo, pctBase = null, limitDefault = 4) {
  const view = state.statsView[grupoKey] || { chart: "bar", expanded: false };
  const outroModo = view.chart === "bar" ? "donut" : "bar";
  const localTotal = grupo.reduce((soma, item) => soma + item.total, 0);
  const body = view.chart === "donut" ? _donutChart(grupo) : _statList(grupo, view.expanded, grupoKey, localTotal, limitDefault);
  const headerPct = pctBase ? Math.round((localTotal / pctBase) * 100) : null;
  return `
    <div class="audience-group">
      <div class="audience-group-title">
        <span>${label}</span>
        <div class="audience-group-actions">
          <button type="button" class="chart-toggle-btn" data-action="toggle-audience-chart" data-group="${grupoKey}" title="Ver como ${outroModo === "donut" ? "rosca" : "barras"}">${outroModo === "donut" ? icon.pieChart() : icon.barChart()}</button>
          <b>${_statCount(localTotal)}${headerPct !== null ? _pctChip(headerPct) : ""}</b>
        </div>
      </div>
      ${body}
    </div>`;
}

function _statList(grupo, expanded, grupoKey, localTotal, limitDefault) {
  const max = grupo[0]?.total || 1;
  const limite = expanded ? grupo.length : limitDefault;
  const topo = grupo.slice(0, limite);
  const outras = Math.max(0, grupo.length - topo.length);
  const row = (item) => {
    const pct = localTotal ? Math.round((item.total / localTotal) * 100) : 0;
    return `<div class="formation-row"><span title="${item.nome}">${item.nome}</span><div class="formation-track"><i style="width:${Math.max(8, Math.round((item.total / max) * 100))}%"></i></div><b>${_statCount(item.total)}${_pctChip(pct)}</b></div>`;
  };
  return `
    <div class="formation-list">${topo.map(row).join("") || `<span class="event-empty-data">Sem dados</span>`}</div>
    ${outras ? `<button type="button" class="event-more-data event-more-data--btn" data-action="toggle-audience-expand" data-group="${grupoKey}">+ ${outras} outras</button>` : (expanded && grupo.length > limitDefault ? `<button type="button" class="event-more-data event-more-data--btn" data-action="toggle-audience-expand" data-group="${grupoKey}">ver menos</button>` : "")}`;
}

// Rosca compacta pro card escuro (Ingressos vendidos) — mesma técnica dos
// outros gráficos, mas com miolo na cor do card (não branco) e paleta clara.
function _salesDonut(pctVendido) {
  const p = Math.max(0, Math.min(100, pctVendido));
  return `
    <div class="sales-donut" style="background: conic-gradient(#fff ${p}%, rgba(255,255,255,.22) ${p}% 100%)">
      <span class="sales-donut-pct">${p}%</span>
    </div>`;
}

function eventoDashboardContent(stats) {
  const insights = eventoInsights();
  const { profissional, estudante, consumidor, semPerfil } = insights.publico;
  const taxaConfirmacao = insights.ingressos ? Math.round((stats.confirmados / insights.ingressos) * 100) : 0;
  const pctConsumidor = insights.ingressos ? Math.round((consumidor.total / insights.ingressos) * 100) : 0;
  const pctSemPerfil  = insights.ingressos ? Math.round((semPerfil.total / insights.ingressos) * 100) : 0;

  // Capacidade total = vendidos + vagas restantes reportadas pela Shopify.
  // Sem esse dado (evento ainda não sincronizado), volta ao card simples.
  const restante = state.evento?.capacidadeDisponivel;
  const temCapacidade = typeof restante === "number";
  const capacidadeTotal = temCapacidade ? insights.ingressos + restante : null;
  const pctVendido = temCapacidade && capacidadeTotal ? Math.round((insights.ingressos / capacidadeTotal) * 100) : null;

  return `
    <section class="event-dashboard" aria-label="Resumo do evento">
      <article class="event-kpi event-kpi--sales">
        <span class="event-kpi-label">Ingressos vendidos</span>
        <div class="sales-hero">
          <div class="sales-hero-main">
            <strong class="event-kpi-value">${insights.ingressos}</strong>
            ${temCapacidade ? `<span class="sales-hero-total">de ${capacidadeTotal} disponíveis · ${restante} restante${restante !== 1 ? "s" : ""}</span>` : ""}
          </div>
          ${temCapacidade ? _salesDonut(pctVendido) : ""}
        </div>
        <span class="event-kpi-note">${stats.confirmados} confirmado${stats.confirmados !== 1 ? "s" : ""} · ${taxaConfirmacao}% da base</span>
      </article>
      <article class="event-audience">
        <div class="event-panel-heading"><div><span class="event-kpi-label">Público por perfil</span><strong>${insights.ingressos} ingresso${insights.ingressos !== 1 ? "s" : ""}</strong></div><span class="event-panel-caption">pagos</span></div>
        ${_statGroup("Profissionais", "profissional", profissional.formacoes, insights.ingressos)}
        ${_statGroup("Estudantes", "estudante", estudante.formacoes, insights.ingressos)}
        <div class="audience-group audience-group--flat"><span>Consumidor final</span><b>${_statCount(consumidor.total)}${_pctChip(pctConsumidor)}</b></div>
        ${semPerfil.total ? `<div class="audience-group audience-group--flat audience-group--muted"><span>Não informado</span><b>${_statCount(semPerfil.total)}${_pctChip(pctSemPerfil)}</b></div>` : ""}
      </article>
      <article class="event-kpi event-kpi--leader">
        <span class="event-kpi-label">Quem mais vendeu</span>
        <div class="leader-list">
          ${insights.vendedores.slice(0, 3).map((v, idx) => {
            const pct = insights.ingressos ? Math.round((v.total / insights.ingressos) * 100) : 0;
            return `<div class="leader-row"><span class="leader-mark">#${idx + 1}</span><span class="leader-name" title="${v.nome}">${v.nome}</span><b>${_statCount(v.total)}${_pctChip(pct)}</b></div>`;
          }).join("") || `<span class="event-empty-data">Sem vendas</span>`}
        </div>
      </article>
      <div class="event-operational-line" aria-label="Operação do evento">
        <span><i class="status-dot status-dot--ok"></i>${stats.confirmados} confirmados</span>
        <span><i class="status-dot status-dot--wait"></i>${stats.naoConfirmados} aguardando confirmação</span>
        <span><i class="status-dot status-dot--info"></i>${stats.presentes} presentes</span>
        ${stats.totalInativos ? `<span><i class="status-dot status-dot--muted"></i>${stats.totalInativos} inativo${stats.totalInativos !== 1 ? "s" : ""}</span>` : ""}
      </div>
    </section>`;
}

function eventoAnalyticsContent() {
  const insights = eventoInsights();
  return `
    <section class="event-analytics" aria-label="Analytics do evento">
      <article class="analytics-panel">
        <div class="event-panel-heading"><div><span class="event-kpi-label">Vendedores</span><strong>${insights.vendedores.length} vendedor${insights.vendedores.length !== 1 ? "es" : ""}</strong></div><span class="event-panel-caption">pagos</span></div>
        ${_statGroup("Todos os vendedores", "vendedores", insights.vendedores, null, 6)}
      </article>
      <article class="analytics-panel">
        <div class="event-panel-heading"><div><span class="event-kpi-label">Público — visão geral</span><strong>${insights.ingressos} ingresso${insights.ingressos !== 1 ? "s" : ""}</strong></div><span class="event-panel-caption">pagos</span></div>
        ${_statGroup("Por perfil", "publico", insights.publico.overview, null, 4)}
      </article>
      <article class="analytics-panel">
        <div class="event-panel-heading"><div><span class="event-kpi-label">Região</span><strong>${insights.ingressos} ingresso${insights.ingressos !== 1 ? "s" : ""}</strong></div><span class="event-panel-caption">pagos</span></div>
        ${_statGroup("Por estado", "estado", insights.regiao.estados, null, 5)}
        ${_statGroup("Por cidade", "cidade", insights.regiao.cidades, null, 5)}
      </article>
    </section>`;
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
      <select class="filter-select" data-filter="valor">
        <option value="">Valor: todos</option>
        <option value="zero" ${state.filters.valor === "zero" ? "selected" : ""}>Gratuitos (R$ 0)</option>
        <option value="pago" ${state.filters.valor === "pago" ? "selected" : ""}>Pagos (acima de R$ 0)</option>
      </select>
      ${hasFilters() ? `<button class="btn-clear" data-action="clear-filters">Limpar filtros</button>` : ""}
    </div>`;
}

function _tableSection(paginated, colSpan = 14) {
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
            ${th("quantidade", "Qtd")}
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

// Única fonte da barra de stats do evento — chamada tanto no render completo
// quanto no update parcial, pra nunca mais divergir entre os dois caminhos
// (foi exatamente essa divergência que causou o bug do filtro de vendedores).
// Os cards com filterValue funcionam como atalho: clicar aplica/remove
// state.filters.status, reaproveitando o filtro que já existe.
function eventoStatsBarContent(stats) {
  return (
    statCard("Total Pagos",      stats.total,          "",               icon.users(), "") +
    statCard("Confirmados",      stats.confirmados,    "confirmado",     icon.checkCircle(), "Confirmado") +
    statCard("Não Confirmados",  stats.naoConfirmados, "nao-confirmado", icon.clock3(), "Não Confirmado") +
    statCard("Presentes",        stats.presentes,      "presente",       icon.mapPin(), "Presente") +
    statCard("Ausentes",         stats.ausentes,       "ausente",        icon.userX(), "Ausente") +
    statCard("Desistentes",      stats.desistentes,    "desistente",     icon.userMinus(), "Desistente") +
    statCard("Cancelados",       stats.cancelados,     "cancelado",      icon.xCircle(), "Cancelado") +
    statCard("Reembolsados",     stats.reembolsados,   "reembolsado",    icon.wallet(), "Reembolsado") +
    (stats.parcReembolsados > 0 ? statCard("Parc. Reembolsados", stats.parcReembolsados, "parcialmente-reembolsado", icon.wallet(), "Parcialmente Reembolsado") : "") +
    (stats.expirados        > 0 ? statCard("Expirados",           stats.expirados,         "expirado",                icon.clock3(), "Expirado")  : "") +
    (stats.pendentes        > 0 ? statCard("Pendentes",           stats.pendentes,          "pendente",                icon.clock3(), "Pendente")  : "") +
    (stats.anulados         > 0 ? statCard("Anulados",            stats.anulados,           "anulado",                 icon.xCircle(), "Anulado") : "") +
    (stats.autorizados      > 0 ? statCard("Autorizados",         stats.autorizados,        "autorizado",              icon.clock3(), "Autorizado")  : "")
  );
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

    <div id="event-dashboard">
      ${eventoDashboardContent(stats)}
    </div>

    <div id="event-analytics">
      ${eventoAnalyticsContent()}
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

// filterValue: quando informado, o card vira um atalho de filtro rápido —
// clicar aplica/remove state.filters.status ("" representa "sem filtro").
// undefined (padrão) mantém o card como exibição, sem interação.
function statCard(label, value, variant = "", iconHtml = "", filterValue = undefined) {
  const cls = variant ? ` stat-card--${variant}` : "";
  const clickable = filterValue !== undefined;
  const isActive = clickable && state.filters.status === filterValue;
  const tag = clickable ? "button" : "div";
  const attrs = clickable
    ? ` type="button" data-action="quick-filter-status" data-status-value="${filterValue}"`
    : "";
  return `
    <${tag} class="stat-card${cls}${clickable ? " stat-card--clickable" : ""}${isActive ? " stat-card--active" : ""}"${attrs}>
      <div class="stat-icon">${iconHtml}</div>
      <b class="stat-value">${value}</b>
      <span class="stat-label">${label}</span>
    </${tag}>`;
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
      <td>${inscrito.quantidade ?? 1}</td>
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
        <span class="mc-qtd">Qtd: ${inscrito.quantidade ?? 1}</span>
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
  if (state.filters.valor === "zero") list = list.filter(i => Number(i.valorFinalPago ?? i.valor ?? 0) === 0);
  if (state.filters.valor === "pago") list = list.filter(i => Number(i.valorFinalPago ?? i.valor ?? 0) > 0);

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

// Confirmação antes de ações em lote — evita que um clique errado em
// "selecionar todos" + um botão de lote altere dezenas de inscritos sem querer.
function confirmBatchAction(n) {
  return confirm(`Tem certeza que deseja alterar ${n} inscrito${n > 1 ? "s" : ""}?\nEssa ação não poderá ser desfeita facilmente.`);
}

// Toast leve para falhas de escrita no Firestore (offline, permissão negada, etc.)
// — sem biblioteca nova, só DOM direto.
function showToast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("toast--visible"));
  setTimeout(() => {
    el.classList.remove("toast--visible");
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// Anexa um aviso de erro genérico a qualquer escrita no Firestore, sem alterar
// o retorno da Promise original (quem chamar ainda pode encadear o próprio .then/.catch).
function withErrorToast(promise, message = "Não foi possível salvar a alteração. Tente novamente.") {
  promise.catch(() => showToast(message));
  return promise;
}

// Mesma ideia para ações em lote — um único toast agregado, não um por linha,
// pra não empilhar vários avisos iguais se a conexão cair no meio da ação.
function withBatchErrorToast(promises) {
  Promise.allSettled(promises).then((results) => {
    if (results.some((r) => r.status === "rejected")) {
      showToast("Algumas alterações não foram salvas. Verifique sua conexão e tente novamente.");
    }
  });
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

// Atualiza só os painéis de estatística (não mexe na tabela/paginação) —
// usado pelos toggles de gráfico/expansão pra não perder o scroll/seleção.
function refreshEventStatsPanels() {
  const stats = inscritosStats();
  const eventDashboard = root.querySelector("#event-dashboard");
  const eventAnalytics = root.querySelector("#event-analytics");
  if (eventDashboard) eventDashboard.innerHTML = eventoDashboardContent(stats);
  if (eventAnalytics) eventAnalytics.innerHTML = eventoAnalyticsContent();
}

function eventoViewPartialUpdate() {
  const inscritos    = filteredInscritos();
  const paginated    = inscritos.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  const totalPages   = Math.ceil(inscritos.length / PAGE_SIZE);
  const stats        = inscritosStats();
  const vendedores   = [...new Set(state.inscritos.map(i => i.vendedor).filter(Boolean))];
  const variantes    = [...new Set(state.inscritos.map(i => i.variante).filter(Boolean))];

  const eventDashboard = root.querySelector("#event-dashboard");
  const eventAnalytics = root.querySelector("#event-analytics");
  const resultsCount   = root.querySelector("#results-count");
  const tbody          = root.querySelector("#inscritos-tbody");
  const paginationWrap = root.querySelector("#pagination-wrap");
  const mobileCards    = root.querySelector("#mobile-cards");
  const batchBar       = root.querySelector("#batch-bar");
  const printCounter   = root.querySelector(".print-counter-bar");
  const exportDetails  = root.querySelector("#export-details");
  const filtersBtnDot  = root.querySelector(".btn-filters-toggle");

  if (eventDashboard) eventDashboard.innerHTML = eventoDashboardContent(stats);
  if (eventAnalytics) eventAnalytics.innerHTML = eventoAnalyticsContent();

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
    ? `<tr><td colspan="14" class="empty-row">Carregando inscritos...</td></tr>`
    : (paginated.length
        ? paginated.map(inscritoRow).join("")
        : `<tr><td colspan="14" class="empty-row">Nenhum inscrito encontrado.</td></tr>`);

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
  hydrateConfirmados(visibleEventosParaConfirmados(sections));

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
      state.filters = { ...DEFAULT_INSCRITO_FILTERS };
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

    // ── Painéis de estatística do evento (público, vendedores, região) ─────
    } else if (action === "toggle-audience-expand") {
      const key = el.dataset.group;
      state.statsView[key] = state.statsView[key] || { chart: "bar", expanded: false };
      state.statsView[key].expanded = !state.statsView[key].expanded;
      refreshEventStatsPanels();
    } else if (action === "toggle-audience-chart") {
      const key = el.dataset.group;
      state.statsView[key] = state.statsView[key] || { chart: "bar", expanded: false };
      state.statsView[key].chart = state.statsView[key].chart === "bar" ? "donut" : "bar";
      refreshEventStatsPanels();

    // ── Status do curso (arquivamento/ocultação) ───────────────────────────────
    } else if (action === "curso-ocultar") {
      withErrorToast(updateCurso(el.dataset.cursoId, { status: CURSO_STATUS.HIDDEN }));
    } else if (action === "curso-encerrar") {
      withErrorToast(updateCurso(el.dataset.cursoId, { status: CURSO_STATUS.FINISHED }));
    } else if (action === "curso-reativar") {
      withErrorToast(updateCurso(el.dataset.cursoId, { status: CURSO_STATUS.ACTIVE }));
    } else if (action === "toggle-curso-sort-dir") {
      state.cursoSortDir = state.cursoSortDir === "asc" ? "desc" : "asc";
      saveNav();
      const filtrosRow = root.querySelector("#cursos-filtros-row");
      if (filtrosRow) filtrosRow.innerHTML = cursosFiltrosRow();
      const grid = root.querySelector("#course-grid");
      if (grid) grid.innerHTML = courseGridContent();
    } else if (action === "quick-filter-status") {
      // Pill de atalho nos stat-cards — clicar de novo no mesmo remove o filtro.
      const value = el.dataset.statusValue;
      state.filters.status = state.filters.status === value ? "" : value;
      state.page = 1;
      saveNav();
      eventoViewPartialUpdate();
      // Mantém o <select> de status da barra de filtros em sincronia com a pill.
      const statusSelect = root.querySelector('[data-filter="status"]');
      if (statusSelect) statusSelect.value = state.filters.status;

    } else if (action === "toggle-impresso") {
      const id = el.dataset.inscritoId;
      const inscrito = state.inscritos.find(i => i.id === id);
      if (inscrito) {
        const novoImpresso = !inscrito.impresso;
        withErrorToast(updateInscrito(state.curso.id, state.evento.id, id, {
          impresso: novoImpresso,
          impressoEm: novoImpresso ? new Date() : null,
          impressoPor: "",
        }));
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
      if (!confirmBatchAction(state.selectedIds.size)) return;
      withBatchErrorToast([...state.selectedIds].map(id =>
        updateInscrito(state.curso.id, state.evento.id, id, { impresso: true, impressoEm: new Date(), impressoPor: "" })
      ));
    } else if (action === "batch-confirmado") {
      if (!confirmBatchAction(state.selectedIds.size)) return;
      withBatchErrorToast([...state.selectedIds].map(id =>
        updateInscrito(state.curso.id, state.evento.id, id, { status: "Confirmado" })
      ));
      _confirmadosCache.delete(state.evento.id);
      state.selectedIds = new Set();
      _partialUpdateSelection();
    } else if (action === "batch-presente") {
      if (!confirmBatchAction(state.selectedIds.size)) return;
      withBatchErrorToast([...state.selectedIds].map(id =>
        updateInscrito(state.curso.id, state.evento.id, id, { status: "Presente" })
      ));
      _confirmadosCache.delete(state.evento.id);
      state.selectedIds = new Set();
      _partialUpdateSelection();

    // ── Ações rápidas mobile ──────────────────────────────────────────────────
    } else if (action === "quick-confirmado") {
      withErrorToast(updateInscrito(state.curso.id, state.evento.id, el.dataset.inscritoId, { status: "Confirmado" }));
      _confirmadosCache.delete(state.evento.id);
    } else if (action === "quick-presente") {
      withErrorToast(updateInscrito(state.curso.id, state.evento.id, el.dataset.inscritoId, { status: "Presente" }));
      _confirmadosCache.delete(state.evento.id);

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
  const sections = computeEventoSections();
  if (grid) grid.innerHTML = eventoGridContent(sections);
  hydrateConfirmados(visibleEventosParaConfirmados(sections));
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
      withErrorToast(updateInscrito(state.curso.id, state.evento.id, id, { observacao: e.target.value }));
    }, 800);
  }
}

function handleChange(e) {
  if (e.target.dataset.cursoFilter !== undefined) {
    const key = e.target.dataset.cursoFilter === "hidden" ? "showHiddenCursos" : "showFinishedCursos";
    state[key] = e.target.checked;
    saveNav();
    const grid = root.querySelector("#course-grid");
    if (grid) grid.innerHTML = courseGridContent();
  }
  if (e.target.dataset.cursoSortKey !== undefined) {
    state.cursoSortKey = e.target.value;
    state.cursoSortDir = CURSO_SORT_DEFAULT_DIR[e.target.value] || "asc";
    saveNav();
    const filtrosRow = root.querySelector("#cursos-filtros-row");
    if (filtrosRow) filtrosRow.innerHTML = cursosFiltrosRow();
    const grid = root.querySelector("#course-grid");
    if (grid) grid.innerHTML = courseGridContent();
  }
  if (e.target.dataset.filter !== undefined) {
    state.filters[e.target.dataset.filter] = e.target.value;
    state.page = 1;
    saveNav();
    render();
  }
  if (e.target.dataset.action === "change-status") {
    const id = e.target.dataset.inscritoId;
    const previousStatus = state.inscritos.find((i) => i.id === id)?.status ?? "";
    const previousClassName = e.target.className;
    const novoStatus = e.target.value;
    // feedback visual imediato sem esperar o round-trip do Firestore
    e.target.className = `status-select status-${statusClass(novoStatus)}`;
    _confirmadosCache.delete(state.evento.id);
    updateInscrito(state.curso.id, state.evento.id, id, { status: novoStatus }).catch(() => {
      // reverte o feedback otimista se a escrita falhar de verdade
      e.target.className = previousClassName;
      e.target.value = previousStatus;
      showToast("Não foi possível salvar o status. Tente novamente.");
    });
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
  state.filters = { ...DEFAULT_INSCRITO_FILTERS };
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
  state.filters = { ...DEFAULT_INSCRITO_FILTERS };
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
  state.filters = { ...DEFAULT_INSCRITO_FILTERS };
  state.page = 1;
  state.statsView = {
    profissional: { chart: "bar", expanded: false },
    estudante:    { chart: "bar", expanded: false },
    publico:      { chart: "bar", expanded: false },
    vendedores:   { chart: "bar", expanded: false },
    estado:       { chart: "bar", expanded: false },
    cidade:       { chart: "bar", expanded: false },
  };
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
  exportList(inscritosSelecionados(), "selecionados");
}
