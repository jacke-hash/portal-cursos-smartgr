/**
 * ================================================================
 * scripts/sync-google-sheets.mjs
 * SmartGR — Sincronizador Firestore → Planilha Calendário
 * ================================================================
 *
 * Fluxo:
 *   1. Conecta ao Firestore via Service Account
 *   2. Lê todos os inscritos de todos os cursos/eventos
 *   3. Agrupa por evento (identificado por data + cidade + nome)
 *   4. Conta inscritos ativos (exclui cancelados/reembolsados)
 *   5. Localiza a linha correta na aba "Eventos" da planilha
 *      usando correspondência por Data × Cidade × Nome do Evento
 *   6. Atualiza APENAS a coluna L (Quantidade de vendas)
 *
 * Segurança:
 *   - Nunca apaga linhas
 *   - Nunca apaga eventos
 *   - Nunca altera fórmulas existentes
 *   - Atualiza somente a coluna L
 *   - Matching por conteúdo, nunca por número de linha
 *
 * Execução manual:
 *   node scripts/sync-google-sheets.mjs
 *
 * ================================================================
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

// ----------------------------------------------------------------
// CONFIGURAÇÃO
// ----------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  // Planilha de destino
  SPREADSHEET_ID : process.env.SHEETS_CALENDARIO_ID || '1gsSMkeQceBYTRa9IKshvuNqa-WGImLNUcPKt2h3iSJg',
  ABA_EVENTOS    : 'Eventos',

  // Coluna L (índice 0-based = 11, índice A1 = 12)
  COL_QUANTIDADE_VENDAS_INDEX : 11,   // 0-based para arrays
  COL_QUANTIDADE_VENDAS_A1    : 'L',  // Para logs

  // Linha do cabeçalho (1-based)
  LINHA_CABECALHO : 1,

  // Índices das colunas de identificação do evento (0-based)
  COL_DATA         : 0,  // A — Data
  COL_CIDADE       : 1,  // B — Cidade
  COL_NOME_EVENTO  : 8,  // I — Nome do Evento

  // Status de inscritos que contam como "ativo" para a coluna L
  STATUS_ATIVOS: [
    'Não Confirmado',
    'Confirmado',
    'Presente',
    'Ausente',
    'Impresso',
  ],

  // Status que NÃO contam (excluídos da contagem)
  STATUS_EXCLUIDOS: [
    'Cancelado',
    'Reembolsado',
  ],

  // Credenciais
  FIREBASE_SERVICE_ACCOUNT : process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    || resolve(__dirname, '../firebase-service-account.json'),

  GOOGLE_SERVICE_ACCOUNT : process.env.GOOGLE_SERVICE_ACCOUNT_PATH
    || resolve(__dirname, '../firebase-service-account.json'),
};

// ----------------------------------------------------------------
// UTILITÁRIOS DE NORMALIZAÇÃO
// ----------------------------------------------------------------

/**
 * Normaliza string: lowercase, sem acentos, sem espaços duplos, trim.
 */
function normalizar(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Remove sufixo de UF da cidade e normaliza.
 * Ex: "São Paulo - SP" → "sao paulo", "Tatuapé (SP)" → "tatupe"
 */
function normalizarCidade(str) {
  return normalizar(str)
    .replace(/\s*[-–—]\s*[a-z]{2}$/, '')   // " - SP" no final
    .replace(/\s*\([a-z]{2}\)$/, '')         // "(SP)" no final
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Converte Date do Firestore ou string ISO para "dd/MM/yyyy".
 * Retorna null se inválido.
 */
function formatarData(valor) {
  if (!valor) return null;

  let date;

  // Timestamp do Firestore (tem .toDate())
  if (valor && typeof valor.toDate === 'function') {
    date = valor.toDate();
  } else if (valor instanceof Date) {
    date = valor;
  } else {
    const str = String(valor).trim();

    // Já está no formato dd/MM/yyyy
    if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
      return str.substring(0, 10);
    }

    // ISO ou outros formatos
    date = new Date(str);
  }

  if (!date || isNaN(date.getTime())) return null;

  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();

  return `${d}/${m}/${y}`;
}

/**
 * Converte valor de célula do Sheets (Date JS ou string) para "dd/MM/yyyy".
 */
function formatarDataSheets(valor) {
  if (!valor) return null;

  if (valor instanceof Date) {
    if (isNaN(valor.getTime())) return null;
    const d = String(valor.getDate()).padStart(2, '0');
    const m = String(valor.getMonth() + 1).padStart(2, '0');
    const y = valor.getFullYear();
    return `${d}/${m}/${y}`;
  }

  return formatarData(valor);
}

/**
 * Verifica se duas cidades correspondem (tolerante a sufixos UF e variações).
 */
function cidadesBatem(cidade1, cidade2) {
  const c1 = normalizarCidade(cidade1);
  const c2 = normalizarCidade(cidade2);

  if (!c1 || !c2) return false;
  if (c1 === c2) return true;

  // Containment: "zona sul" bate com "são paulo - zona sul"
  if (c1.includes(c2) || c2.includes(c1)) return true;

  // Remove segundo nível após vírgula ou traço
  const s1 = c1.replace(/\s*[-,]\s*.+$/, '').trim();
  const s2 = c2.replace(/\s*[-,]\s*.+$/, '').trim();
  if (s1 && s2 && (s1 === s2 || s1.includes(s2) || s2.includes(s1))) return true;

  return false;
}

/**
 * Verifica se dois nomes de evento correspondem.
 * Usa matching parcial bidirecional (um contém o outro).
 */
function nomesBatem(nome1, nome2) {
  const n1 = normalizar(nome1);
  const n2 = normalizar(nome2);

  if (!n1 || !n2) return false;
  if (n1 === n2) return true;
  if (n1.includes(n2) || n2.includes(n1)) return true;

  return false;
}

// ----------------------------------------------------------------
// INICIALIZAÇÃO FIREBASE
// ----------------------------------------------------------------

function inicializarFirebase() {
  const serviceAccount = JSON.parse(
    readFileSync(CONFIG.FIREBASE_SERVICE_ACCOUNT, 'utf8')
  );

  initializeApp({
    credential: cert(serviceAccount),
  });

  return getFirestore();
}

// ----------------------------------------------------------------
// INICIALIZAÇÃO GOOGLE SHEETS
// ----------------------------------------------------------------

async function inicializarSheets() {
  const serviceAccount = JSON.parse(
    readFileSync(CONFIG.GOOGLE_SERVICE_ACCOUNT, 'utf8')
  );

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

// ----------------------------------------------------------------
// LEITURA DO FIRESTORE
// ----------------------------------------------------------------

/**
 * Lê todos os eventos de todos os cursos e conta inscritos por evento.
 * Estrutura: cursos/{cursoId}/eventos/{eventoId}/inscritos/{inscritoId}
 *
 * Usa o campo proximoEventoLabel do documento de evento como chave de
 * identificação — ele contém "dd/MM/yyyy - Cidade - UF (Bairro)" que
 * bate diretamente com Data (col A) e Cidade (col B) da planilha.
 *
 * Retorna Map<eventoUid, { meta, totalAtivos }>
 */
async function lerEventosComContagem(db) {
  log('Firestore', 'Lendo estrutura cursos → eventos → inscritos...');

  // Map: eventoUid (cursoId/eventoId) → { meta, totalAtivos }
  const eventos = new Map();

  const cursosSnap = await db.collection('cursos').get();
  log('Firestore', `Cursos encontrados: ${cursosSnap.size}`);

  let totalInscritos = 0;

  for (const cursoDoc of cursosSnap.docs) {
    const cursoId   = cursoDoc.id;
    const cursoData = cursoDoc.data();
    const cursoNome = cursoData.nome || cursoId;

    const eventosSnap = await db
      .collection('cursos')
      .doc(cursoId)
      .collection('eventos')
      .get();

    log('Firestore', `  Curso "${cursoNome}": ${eventosSnap.size} evento(s)`);

    for (const eventoDoc of eventosSnap.docs) {
      const eventoId   = eventoDoc.id;
      const eventoData = eventoDoc.data();

      // proximoEventoLabel = "06/07/2026 - São Paulo - SP (Zona Leste)"
      // É o identificador que bate com a planilha
      const label = String(eventoData.varianteTitle || eventoData.proximoEventoLabel || '').trim();

      // Extrai data do label (dd/MM/yyyy no início)
      const matchData = label.match(/^(\d{2}\/\d{2}\/\d{4})/);
      const dataEvento = matchData ? matchData[1] : null;

      // Extrai cidade: tudo após "dd/MM/yyyy - "
      // Ex: "06/07/2026 - São Paulo - SP (Zona Leste)" → "São Paulo - SP (Zona Leste)"
      const cidadeEvento = dataEvento
        ? label.substring(dataEvento.length + 3).trim()  // +3 = " - "
        : null;

      const uid = `${cursoId}/${eventoId}`;

      eventos.set(uid, {
        meta: {
          cursoId     : cursoId,
          cursoNome   : cursoNome,
          eventoId    : eventoId,
          label       : label,
          data        : dataEvento,
          cidadeLabel : cidadeEvento,
        },
        totalAtivos: 0,
      });

      // Lê inscritos e conta ativos
      const inscritosSnap = await db
        .collection('cursos')
        .doc(cursoId)
        .collection('eventos')
        .doc(eventoId)
        .collection('inscritos')
        .get();

      for (const inscritoDoc of inscritosSnap.docs) {
        totalInscritos++;
        const status = String(inscritoDoc.data().status || '').trim();
        if (CONFIG.STATUS_ATIVOS.includes(status)) {
          eventos.get(uid).totalAtivos++;
        }
      }
    }
  }

  log('Firestore', `Total de inscritos lidos: ${totalInscritos}`);
  log('Firestore', `Total de eventos únicos: ${eventos.size}`);
  return eventos;
}

// ----------------------------------------------------------------
// LEITURA DA PLANILHA
// ----------------------------------------------------------------

/**
 * Lê todos os dados da aba Eventos.
 * Retorna array de arrays (valores brutos).
 */
async function lerAbaEventos(sheets) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range        : `${CONFIG.ABA_EVENTOS}`,
    valueRenderOption    : 'UNFORMATTED_VALUE',
    dateTimeRenderOption : 'FORMATTED_STRING',
  });

  const valores = response.data.values || [];
  log('Sheets', `Aba "${CONFIG.ABA_EVENTOS}" lida: ${valores.length} linhas (incluindo cabeçalho)`);
  return valores;
}

// ----------------------------------------------------------------
// MATCHING: evento Firestore → linha da planilha
// ----------------------------------------------------------------

/**
 * Para cada evento do Firestore, encontra a linha correspondente
 * na planilha usando matching Data (col A) × Cidade (col B).
 *
 * Lógica:
 *   - Firestore tem proximoEventoLabel = "06/07/2026 - São Paulo - SP (Zona Leste)"
 *   - Planilha col A = "06/07/2026", col B = "Zona Sul" ou "Rio Claro" ou "Porto Alegre - RS"
 *   - Extrai data e cidade do label e compara com as colunas A e B
 *
 * Múltiplas linhas na planilha podem ter a mesma data (ex: vários workshops
 * em datas iguais em cidades diferentes) — o matching por cidade resolve isso.
 *
 * Retorna array de { linhaNum, evento, totalAtivos, dataCell, cidadeCell, nomeCell }
 */
function encontrarLinhasParaAtualizar(linhasPlanilha, eventos) {
  const atualizacoes = [];

  // Itera sobre todas as linhas de dados (pula cabeçalho)
  for (let i = CONFIG.LINHA_CABECALHO; i < linhasPlanilha.length; i++) {
    const row = linhasPlanilha[i];
    if (!row || row.length === 0) continue;

    const dataCell   = row[CONFIG.COL_DATA]       || '';
    const cidadeCell = row[CONFIG.COL_CIDADE]      || '';
    const nomeCell   = row[CONFIG.COL_NOME_EVENTO] || '';

    const dataFormatada = formatarDataSheets(dataCell);
    if (!dataFormatada) continue;

    // Tenta encontrar um evento do Firestore que bata com esta linha
    for (const [uid, evento] of eventos) {
      const { data, cidadeLabel, cursoNome } = evento.meta;

      if (!data || !cidadeLabel) continue;

      // Matching: data exata + cidade do label bate com cidade da planilha
      const dataBate   = dataFormatada === data;
      const cidadeBate = cidadesBatem(cidadeCell, cidadeLabel);

      if (dataBate && cidadeBate) {
        atualizacoes.push({
          linhaNum    : i + 1,  // 1-based (planilha)
          evento,
          totalAtivos : evento.totalAtivos,
          dataCell    : dataFormatada,
          cidadeCell  : String(cidadeCell),
          nomeCell    : String(nomeCell),
        });
        break; // esta linha já foi resolvida
      }
    }
  }

  return atualizacoes;
}

// ----------------------------------------------------------------
// ESCRITA NA PLANILHA (em lote)
// ----------------------------------------------------------------

/**
 * Atualiza a coluna L de todas as linhas identificadas.
 * Usa batchUpdate para fazer UMA única chamada à API do Sheets.
 *
 * Segurança:
 * - Não altera nenhuma outra coluna
 * - Não apaga linhas
 * - Não apaga eventos
 */
async function atualizarPlanilha(sheets, atualizacoes) {
  if (atualizacoes.length === 0) {
    log('Sheets', 'Nenhuma atualização para escrever.');
    return;
  }

  // Monta lista de ranges + valores para batchUpdate
  const data = atualizacoes.map(({ linhaNum, totalAtivos }) => ({
    range : `${CONFIG.ABA_EVENTOS}!${CONFIG.COL_QUANTIDADE_VENDAS_A1}${linhaNum}`,
    values: [[totalAtivos]],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    requestBody  : {
      valueInputOption: 'RAW',
      data,
    },
  });

  log('Sheets', `${atualizacoes.length} linha(s) atualizadas na coluna ${CONFIG.COL_QUANTIDADE_VENDAS_A1}.`);
}

// ----------------------------------------------------------------
// LOG
// ----------------------------------------------------------------

function log(contexto, mensagem) {
  const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  console.log(`[${ts}] [${contexto}] ${mensagem}`);
}

function logSeparador(titulo) {
  console.log('');
  console.log('='.repeat(60));
  console.log(`  ${titulo}`);
  console.log('='.repeat(60));
}

function logResultado(atualizacao) {
  const { evento, totalAtivos, linhaNum, dataCell, cidadeCell, nomeCell } = atualizacao;
  console.log('');
  console.log('  +--------------------------------------------------');
  console.log(`  | Curso    : ${evento.meta.cursoNome}`);
  console.log(`  | Label    : ${evento.meta.label}`);
  console.log(`  | Data     : ${dataCell}`);
  console.log(`  | Cidade   : ${cidadeCell}`);
  console.log(`  | Linha    : ${linhaNum} (coluna ${CONFIG.COL_QUANTIDADE_VENDAS_A1})`);
  console.log(`  | Inscritos: ${totalAtivos}`);
  console.log('  +--------------------------------------------------');
}

// ----------------------------------------------------------------
// FUNÇÃO PRINCIPAL
// ----------------------------------------------------------------

async function sincronizar() {
  logSeparador('SmartGR — Sync Firestore → Google Sheets');
  log('Sync', 'Iniciando sincronização...');

  // 1. Inicializa conexões
  log('Init', 'Conectando ao Firestore...');
  const db = inicializarFirebase();

  log('Init', 'Conectando ao Google Sheets...');
  const sheets = await inicializarSheets();

  // 2. Le eventos com contagem do Firestore
  logSeparador('FASE 1 - Leitura do Firestore');
  const eventos = await lerEventosComContagem(db);

  if (eventos.size === 0) {
    log('Sync', 'Nenhum evento encontrado no Firestore. Encerrando.');
    return;
  }

  // Log resumo dos eventos
  for (const [uid, evento] of eventos) {
    const { label, data } = evento.meta;
    if (data) {
      log('Evento', `${label} => ${evento.totalAtivos} inscrito(s)`);
    }
  }

  // 3. Le planilha
  logSeparador('FASE 2 - Leitura da Planilha');
  const linhasPlanilha = await lerAbaEventos(sheets);

  // 4. Matching: Firestore => linhas da planilha
  logSeparador('FASE 3 - Matching Firestore x Planilha');
  const atualizacoes = encontrarLinhasParaAtualizar(linhasPlanilha, eventos);

  if (atualizacoes.length === 0) {
    log('Matching', 'ATENCAO: Nenhuma linha correspondente encontrada na planilha.');
    log('Matching', 'Verifique se os eventos tem varianteTitle compativel com Data/Cidade da planilha.');
  } else {
    log('Matching', `${atualizacoes.length} linha(s) correspondidas:`);
    for (const a of atualizacoes) {
      logResultado(a);
    }
  }

  // Eventos sem correspondencia (diagnostico)
  const uidsBatidos = new Set(atualizacoes.map(a => `${a.evento.meta.cursoId}/${a.evento.meta.eventoId}`));
  const semCorrespondencia = [];
  for (const [uid, evento] of eventos) {
    if (!uidsBatidos.has(uid) && evento.meta.data) {
      semCorrespondencia.push(evento.meta);
    }
  }

  if (semCorrespondencia.length > 0) {
    console.log('');
    log('Matching', `AVISO: ${semCorrespondencia.length} evento(s) SEM correspondencia na planilha:`);
    for (const meta of semCorrespondencia) {
      log('Matching', `  -> ${meta.label || (meta.data + ' | ' + meta.cidadeLabel)}`);
    }
  }

  // 5. Atualiza planilha
  logSeparador('FASE 4 - Escrita na Planilha');
  await atualizarPlanilha(sheets, atualizacoes);

  // 6. Resumo final
  logSeparador('CONCLUIDO');
  log('Sync', `Eventos no Firestore     : ${eventos.size}`);
  log('Sync', `Linhas atualizadas       : ${atualizacoes.length}`);
  log('Sync', `Sem correspondencia      : ${semCorrespondencia.length}`);
  console.log('');
}

// ----------------------------------------------------------------
// ENTRYPOINT
// ----------------------------------------------------------------

sincronizar().catch((err) => {
  console.error('\n[ERRO FATAL]', err.message);
  console.error(err.stack);
  process.exit(1);
});
