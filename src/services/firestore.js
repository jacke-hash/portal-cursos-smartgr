import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "./firebase.js";

// Mesma regra de "inscrito ativo" usada em src/components/app.js (isInscritoAtivo) e nos
// scripts de sincronização — duplicada aqui de propósito (mesmo padrão já usado no resto
// do projeto, ver scripts/fix-confirmados-agregado.mjs). Mudou lá, muda aqui também.
const INACTIVE_STATUS_LABELS = new Set([
  "Cancelado", "Reembolsado", "Parcialmente Reembolsado",
  "Expirado", "Pendente", "Autorizado", "Anulado",
]);
function isInscritoAtivo(i) {
  if (i.financialStatus) return i.financialStatus === "paid";
  return !INACTIVE_STATUS_LABELS.has(i.status);
}

export function listenCursos(callback) {
  const ref = collection(db, "cursos");
  return onSnapshot(
    query(ref, where("ativo", "==", true), orderBy("nome")),
    (snap) => {
      callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    (error) => {
      console.error("[Firestore] Erro em listenCursos:", error.code, error.message);
    }
  );
}

export function listenEventos(cursoId, callback) {
  const ref = collection(db, "cursos", cursoId, "eventos");
  return onSnapshot(
    query(ref, where("ativo", "==", true), orderBy("data")),
    (snap) => {
      callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    (error) => {
      console.error("[Firestore] Erro em listenEventos:", error.code, error.message);
    }
  );
}

export function listenEncerrados(cursoId, callback) {
  const ref = collection(db, "cursos", cursoId, "eventos");
  return onSnapshot(
    query(ref, where("encerrado", "==", true)),
    (snap) => {
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      // ordenação client-side: mais recente primeiro
      docs.sort((a, b) => {
        const da = a.data?.toDate?.() ?? null;
        const db_ = b.data?.toDate?.() ?? null;
        if (!da && !db_) return 0;
        if (!da) return 1;
        if (!db_) return -1;
        return db_ - da;
      });
      callback(docs);
    },
    (error) => {
      console.error("[Firestore] Erro em listenEncerrados:", error.code, error.message);
    }
  );
}

// Listener do doc do próprio evento (capacidadeDisponivel, totalInscritos,
// confirmados etc.) — sem isso, esses campos só atualizavam ao reabrir a
// página, diferente do resto do dashboard que acompanha o Firestore ao vivo.
export function listenEvento(cursoId, eventoId, callback) {
  const ref = doc(db, "cursos", cursoId, "eventos", eventoId);
  return onSnapshot(
    ref,
    (snap) => {
      callback(snap.exists() ? { id: snap.id, ...snap.data() } : null);
    },
    (error) => {
      console.error("[Firestore] Erro em listenEvento:", error.code, error.message);
    }
  );
}

export function listenInscritos(cursoId, eventoId, callback) {
  const ref = collection(db, "cursos", cursoId, "eventos", eventoId, "inscritos");
  return onSnapshot(
    query(ref, orderBy("dataCompra", "desc")),
    (snap) => {
      callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    (error) => {
      console.error("[Firestore] Erro em listenInscritos:", error.code, error.message);
    }
  );
}

// Leitura pontual (não listener) dos inscritos com status "Confirmado"/"Presente" de um
// evento — usada pelo card de listagem (hydrateConfirmados) e por updateInscrito abaixo
// para recalcular o campo agregado. Filtra status no servidor para trazer só o subconjunto
// relevante; o critério de "ativo" (pago) ainda precisa ser aplicado pelo chamador com
// isInscritoAtivo.
export async function getInscritosConfirmados(cursoId, eventoId) {
  const ref = collection(db, "cursos", cursoId, "eventos", eventoId, "inscritos");
  const snap = await getDocs(query(ref, where("status", "in", ["Confirmado", "Presente"])));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Recalcula e grava o agregado `confirmados` do evento a partir da subcoleção de inscritos.
// Chamado em background por updateInscrito quando o status muda — nunca lançado pro chamador
// (só logado), porque o card de listagem já não depende deste campo para exibir o número
// certo; ele existe só para quem lê o Firestore bruto (exports, relatórios).
async function recalcConfirmados(cursoId, eventoId) {
  try {
    const confirmados = (await getInscritosConfirmados(cursoId, eventoId)).filter(isInscritoAtivo).length;
    await updateEvento(cursoId, eventoId, { confirmados });
  } catch (e) {
    console.error("[Firestore] Falha ao recalcular confirmados:", e.code || e.message);
  }
}

export function updateInscrito(cursoId, eventoId, inscritoId, patch) {
  const ref = doc(db, "cursos", cursoId, "eventos", eventoId, "inscritos", inscritoId);
  const result = updateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
  if ("status" in patch) {
    // roda em background: não atrasa nem falha a ação principal do usuário
    result.then(() => recalcConfirmados(cursoId, eventoId)).catch(() => {});
  }
  return result;
}

export function updateEvento(cursoId, eventoId, patch) {
  const ref = doc(db, "cursos", cursoId, "eventos", eventoId);
  return updateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
}

export function updateCurso(cursoId, patch) {
  const ref = doc(db, "cursos", cursoId);
  return updateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
}