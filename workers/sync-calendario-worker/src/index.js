/**
 * ================================================================
 * sync-calendario-worker
 * SmartGR — Sincronizador Firestore → Planilha Calendário
 * (Cloudflare Worker — versão real-time do scripts/sync-google-sheets.mjs)
 * ================================================================
 *
 * Roda em duas formas:
 *   1. Cron Trigger (* /15 * * * *) — polling confiável, sem os atrasos
 *      do scheduler do GitHub Actions.
 *   2. Fetch handler (GET /run) — permite disparo manual via URL,
 *      útil pra testar sem precisar do wrangler tail + deploy.
 *
 * Mesma lógica de negócio do script .mjs original:
 *   - Matching por Data (col A) × Cidade (col B), tolerante a UF/sufixos
 *   - Conta como "ativo": Não Confirmado, Confirmado, Presente, Ausente, Impresso
 *   - Exclui da contagem: Cancelado, Reembolsado
 *   - Atualiza APENAS a coluna L (Quantidade de vendas)
 *   - Nunca apaga linhas, nunca altera fórmulas, nunca mexe em outras colunas
 * ================================================================
 */

// ----------------------------------------------------------------
// CONFIGURAÇÃO
// ----------------------------------------------------------------

const ABA_EVENTOS = 'Eventos';

// Índices das colunas (0-based)
const COL_DATA = 0;         // A — Data
const COL_CIDADE = 1;       // B — Cidade
const COL_NOME_EVENTO = 8;  // I — Nome do Evento
const COL_QTD_VENDAS_A1 = 'L';

const LINHA_CABECALHO = 1; // 0-based no array de linhas (pula a 1ª linha)

const STATUS_ATIVOS = [
  'Não Confirmado',
  'Confirmado',
  'Presente',
  'Ausente',
  'Impresso',
];

const STATUS_EXCLUIDOS = ['Cancelado', 'Reembolsado'];

// ----------------------------------------------------------------
// UTILITÁRIOS DE NORMALIZAÇÃO (portados 1:1 do script original)
// ----------------------------------------------------------------

function normalizar(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

function normalizarCidade(str) {
  return normalizar(str)
    .replace(/\s*[-–—]\s*[a-z]{2}$/, '')
    .replace(/\s*\([a-z]{2}\)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatarDataStr(valor) {
  if (!valor) return null;
  const str = String(valor).trim();

  if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
    return str.substring(0, 10);
  }

  const date = new Date(str);
  if (isNaN(date.getTime())) return null;

  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

function cidadesBatem(cidade1, cidade2) {
  const c1 = normalizarCidade(cidade1);
  const c2 = normalizarCidade(cidade2);

  if (!c1 || !c2) return false;
  if (c1 === c2) return true;
  if (c1.includes(c2) || c2.includes(c1)) return true;

  const s1 = c1.replace(/\s*[-,]\s*.+$/, '').trim();
  const s2 = c2.replace(/\s*[-,]\s*.+$/, '').trim();
  if (s1 && s2 && (s1 === s2 || s1.includes(s2) || s2.includes(s1))) return true;

  return false;
}

// ----------------------------------------------------------------
// AUTENTICAÇÃO GOOGLE (JWT manual via Web Crypto — sem googleapis)
// ----------------------------------------------------------------

function base64url(input) {
  let str;
  if (typeof input === 'string') {
    str = btoa(unescape(encodeURIComponent(input)));
  } else {
    // ArrayBuffer → base64
    const bytes = new Uint8Array(input);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    str = btoa(bin);
  }
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function getAccessToken(serviceAccount, scopes) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccount.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;

  const keyData = pemToArrayBuffer(serviceAccount.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );

  const jwt = `${unsigned}.${base64url(signature)}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Falha ao obter access token: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// ----------------------------------------------------------------
// FIRESTORE — REST API (collection group queries)
// ----------------------------------------------------------------

function firestoreValueToJs(value) {
  if (value == null) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return new Date(value.timestampValue);
  if ('nullValue' in value) return null;
  if ('mapValue' in value) return firestoreDocToObject(value.mapValue.fields || {});
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(firestoreValueToJs);
  return null;
}

function firestoreDocToObject(fields) {
  const obj = {};
  for (const [key, value] of Object.entries(fields || {})) {
    obj[key] = firestoreValueToJs(value);
  }
  return obj;
}

/**
 * Roda uma collection group query (busca em TODAS as subcoleções
 * com esse collectionId, em qualquer profundidade).
 *
 * Pagina de verdade usando orderBy(__name__) + startAt no cursor do
 * último documento lido — sem isso, bancos com mais de `pageLimit`
 * documentos na coleção (somando TODOS os cursos/eventos) ficavam
 * truncados silenciosamente, subcontando inscritos.
 */
async function runCollectionGroupQuery(projectId, accessToken, collectionId, pageLimit = 300) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;

  const results = [];
  let cursorName = null; // __name__ (caminho completo) do último doc lido
  let done = false;

  while (!done) {
    const structuredQuery = {
      from: [{ collectionId, allDescendants: true }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: pageLimit,
    };

    if (cursorName) {
      structuredQuery.startAt = {
        values: [{ referenceValue: cursorName }],
        before: false,
      };
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ structuredQuery }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Firestore runQuery falhou (${collectionId}): ${resp.status} ${text}`);
    }

    const batch = await resp.json();
    const docs = batch.filter((item) => item.document);

    for (const item of docs) {
      results.push(item.document);
    }

    if (docs.length < pageLimit) {
      done = true;
    } else {
      // Ainda pode haver mais — continua a partir do último doc deste lote
      cursorName = docs[docs.length - 1].document.name;
    }
  }

  return results;
}

// ----------------------------------------------------------------
// LEITURA FIRESTORE: eventos + inscritos → contagem por evento
// ----------------------------------------------------------------

// Versões normalizadas (sem acento, minúsculo, sem espaço extra) para
// comparação resistente a diferenças sutis de encoding/whitespace que
// causavam undercount silencioso (ex: "Não Confirmado " com espaço,
// ou acento em forma NFD vs NFC).
const STATUS_ATIVOS_NORM = STATUS_ATIVOS.map(normalizar);

async function lerEventosComContagem(projectId, accessToken) {
  // 1. Todos os documentos de "eventos" (qualquer curso)
  const eventoDocs = await runCollectionGroupQuery(projectId, accessToken, 'eventos');

  const eventos = new Map(); // uid "cursoId/eventoId" → { meta, totalAtivos }

  for (const doc of eventoDocs) {
    // doc.name = ".../documents/cursos/{cursoId}/eventos/{eventoId}"
    const parts = doc.name.split('/documents/')[1].split('/');
    const cursoId = parts[1];
    const eventoId = parts[3];
    const data = firestoreDocToObject(doc.fields);

    const label = String(data.varianteTitle || data.proximoEventoLabel || '').trim();
    const matchData = label.match(/^(\d{2}\/\d{2}\/\d{4})/);
    const dataEvento = matchData ? matchData[1] : null;
    const cidadeEvento = dataEvento ? label.substring(dataEvento.length + 3).trim() : null;

    eventos.set(`${cursoId}/${eventoId}`, {
      meta: {
        cursoId,
        eventoId,
        cursoNome: cursoId, // collection group não traz o nome do curso-pai; suficiente para log
        label,
        data: dataEvento,
        cidadeLabel: cidadeEvento,
      },
      totalAtivos: 0,
    });
  }

  // 2. Todos os documentos de "inscritos" (qualquer evento, qualquer curso)
  // — uma única query paginada, mantendo poucos subrequests (importante:
  // Cloudflare Workers no plano Free limita subrequests por invocação).
  const inscritoDocs = await runCollectionGroupQuery(projectId, accessToken, 'inscritos');

  let totalInscritos = 0;
  const statusNaoReconhecidos = new Set();

  for (const doc of inscritoDocs) {
    // doc.name = ".../cursos/{cursoId}/eventos/{eventoId}/inscritos/{inscritoId}"
    const parts = doc.name.split('/documents/')[1].split('/');
    const cursoId = parts[1];
    const eventoId = parts[3];
    const uid = `${cursoId}/${eventoId}`;

    const data = firestoreDocToObject(doc.fields);
    const status = String(data.status || '').trim();
    const statusNorm = normalizar(status);

    totalInscritos++;

    const isAtivo = STATUS_ATIVOS_NORM.includes(statusNorm);
    const isExcluido = STATUS_EXCLUIDOS.some((s) => normalizar(s) === statusNorm);

    if (!isAtivo && !isExcluido && status) {
      // Status que não bate com NENHUMA lista conhecida (mesmo normalizado)
      // — loga pra investigação, mas não quebra a execução.
      statusNaoReconhecidos.add(status);
    }

    if (eventos.has(uid) && isAtivo) {
      eventos.get(uid).totalAtivos++;
    }
  }

  if (statusNaoReconhecidos.size > 0) {
    console.log(
      `[Firestore] AVISO: status não reconhecidos encontrados (não contados): ${[...statusNaoReconhecidos].join(', ')}`
    );
  }

  console.log(`[Firestore] Eventos: ${eventos.size} | Inscritos lidos: ${totalInscritos}`);
  return eventos;
}

// ----------------------------------------------------------------
// GOOGLE SHEETS — REST API
// ----------------------------------------------------------------

async function lerAbaEventos(spreadsheetId, accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
    ABA_EVENTOS
  )}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Falha ao ler planilha: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  return data.values || [];
}

function encontrarLinhasParaAtualizar(linhasPlanilha, eventos) {
  const atualizacoes = [];

  for (let i = LINHA_CABECALHO; i < linhasPlanilha.length; i++) {
    const row = linhasPlanilha[i];
    if (!row || row.length === 0) continue;

    const dataCell = row[COL_DATA] || '';
    const cidadeCell = row[COL_CIDADE] || '';
    const nomeCell = row[COL_NOME_EVENTO] || '';

    const dataFormatada = formatarDataStr(dataCell);
    if (!dataFormatada) continue;

    for (const [uid, evento] of eventos) {
      const { data, cidadeLabel } = evento.meta;
      if (!data || !cidadeLabel) continue;

      const dataBate = dataFormatada === data;
      const cidadeBate = cidadesBatem(cidadeCell, cidadeLabel);

      if (dataBate && cidadeBate) {
        atualizacoes.push({
          linhaNum: i + 1, // 1-based
          evento,
          totalAtivos: evento.totalAtivos,
          dataCell: dataFormatada,
          cidadeCell: String(cidadeCell),
          nomeCell: String(nomeCell),
        });
        break;
      }
    }
  }

  return atualizacoes;
}

async function atualizarPlanilha(spreadsheetId, accessToken, atualizacoes) {
  if (atualizacoes.length === 0) {
    console.log('[Sheets] Nenhuma atualização para escrever.');
    return;
  }

  const data = atualizacoes.map(({ linhaNum, totalAtivos }) => ({
    range: `${ABA_EVENTOS}!${COL_QTD_VENDAS_A1}${linhaNum}`,
    values: [[totalAtivos]],
  }));

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Falha ao atualizar planilha: ${resp.status} ${text}`);
  }

  const result = await resp.json();
  console.log(
    `[Sheets] ${atualizacoes.length} linha(s) atualizadas. totalUpdatedCells=${result.totalUpdatedCells}`
  );
}

// ----------------------------------------------------------------
// FLUXO PRINCIPAL
// ----------------------------------------------------------------

async function sincronizar(env) {
  const t0 = Date.now();
  console.log('=== SmartGR — Sync Firestore → Sheets (Cloudflare Worker) ===');

  const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const projectId = serviceAccount.project_id;
  const spreadsheetId = env.SHEETS_CALENDARIO_ID;

  const accessToken = await getAccessToken(serviceAccount, [
    'https://www.googleapis.com/auth/datastore',
    'https://www.googleapis.com/auth/spreadsheets',
  ]);

  const eventos = await lerEventosComContagem(projectId, accessToken);

  if (eventos.size === 0) {
    console.log('[Sync] Nenhum evento encontrado no Firestore. Encerrando.');
    return { ok: true, eventos: 0, atualizacoes: 0 };
  }

  const linhasPlanilha = await lerAbaEventos(spreadsheetId, accessToken);
  const atualizacoes = encontrarLinhasParaAtualizar(linhasPlanilha, eventos);

  for (const a of atualizacoes) {
    console.log(
      `[Match] ${a.evento.meta.label} → linha ${a.linhaNum} → ${a.totalAtivos} inscrito(s)`
    );
  }

  const uidsBatidos = new Set(atualizacoes.map((a) => `${a.evento.meta.cursoId}/${a.evento.meta.eventoId}`));
  const semCorrespondencia = [...eventos.entries()].filter(
    ([uid, ev]) => !uidsBatidos.has(uid) && ev.meta.data
  );
  if (semCorrespondencia.length > 0) {
    console.log(`[Match] AVISO: ${semCorrespondencia.length} evento(s) sem linha correspondente.`);
  }

  await atualizarPlanilha(spreadsheetId, accessToken, atualizacoes);

  const ms = Date.now() - t0;
  console.log(`=== Concluído em ${ms}ms — ${atualizacoes.length} linha(s) atualizadas ===`);

  return {
    ok: true,
    eventos: eventos.size,
    atualizacoes: atualizacoes.length,
    semCorrespondencia: semCorrespondencia.length,
    ms,
  };
}

// ----------------------------------------------------------------
// EXPORTS DO WORKER
// ----------------------------------------------------------------

export default {
  // Disparo automático pelo Cron Trigger (wrangler.toml)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sincronizar(env).catch((err) => console.error('[ERRO FATAL]', err.stack || err)));
  },

  // Disparo manual: GET https://sync-calendario-worker.<subdomain>.workers.dev/run
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/ping2') {
      return new Response('pong2-ok', { status: 200 });
    }

    if (url.pathname === '/debug-secret') {
      // Endpoint de diagnóstico seguro — nunca retorna bytes reais do segredo,
      // só metadados suficientes para confirmar integridade (truncamento/corrupção).
      const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
      const info = { length: raw.length };
      try {
        const parsed = JSON.parse(raw);
        info.parseOk = true;
        info.keys = Object.keys(parsed).sort();
        info.hasPrivateKey = !!parsed.private_key;
        info.privateKeyLength = parsed.private_key?.length ?? 0;
      } catch (e) {
        info.parseOk = false;
        info.parseError = e.message;
      }
      return new Response(JSON.stringify(info, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/run') {
      try {
        const resultado = await sincronizar(env);
        return new Response(JSON.stringify(resultado, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }, null, 2), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('sync-calendario-worker ativo. Use GET /run para disparo manual.', {
      status: 200,
    });
  },
};
