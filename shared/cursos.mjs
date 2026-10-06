// Catálogo de cursos monitorados pelos scripts auxiliares — lido da coleção
// `cursos` do Firestore (criada/atualizada pelo worker shopify-webhook e por
// scripts/sync-shopify.mjs), em vez de uma lista fixa copiada em cada script.
// Recebe a instância do firebase-admin (`getFirestore()`) já inicializada.

// Devolve Map productId (number) → { id, nome, ...campos do doc }.
// Critério de ativo: `ativo !== false` — mesmo campo que o portal filtra
// (where("ativo", "==", true)); `status` (hidden/finished) NÃO exclui, pois
// cursos ocultos/encerrados continuam precisando de agregados, capacidade e
// backfills.
//
// Aborta (lança erro) se o Firestore falhar ou se não sobrar nenhum curso:
// seguir com lista vazia faria os scripts não varrerem nada (ou, pior, darem
// a impressão de que tudo está em dia / zerar agregados por engano).
export async function loadCursos(db, { log = console.log } = {}) {
  let snap;
  try {
    snap = await db.collection('cursos').get();
  } catch (e) {
    throw new Error(
      `loadCursos: não foi possível ler a coleção "cursos" no Firestore (${e.message}). ` +
      `Abortando para não continuar com lista de cursos vazia.`
    );
  }

  const cursos = new Map();
  let inativos = 0, idsInvalidos = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.ativo === false) { inativos++; continue; }
    const id = Number(doc.id);
    if (!Number.isSafeInteger(id) || id <= 0) { idsInvalidos++; continue; }
    cursos.set(id, { ...data, id, nome: data.nome || doc.id });
  }

  log(
    `Cursos carregados do Firestore: ${cursos.size} | ignorados por ativo:false: ${inativos}` +
    (idsInvalidos ? ` | ignorados por ID não numérico: ${idsInvalidos}` : '')
  );

  if (cursos.size === 0) {
    throw new Error(
      `loadCursos: nenhum curso ativo encontrado em "cursos" (${snap.size} documento(s) lido(s), ` +
      `${inativos} com ativo:false). Abortando para não zerar agregados/capacidade por engano.`
    );
  }
  return cursos;
}
