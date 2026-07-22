import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "./firebase.js";

export function listenCursos(callback) {
  console.log("[Firestore] listenCursos: iniciando query...");
  const ref = collection(db, "cursos");
  return onSnapshot(
    query(ref, where("ativo", "==", true), orderBy("nome")),
    (snap) => {
      console.log("[Firestore] Cursos encontrados:", snap.size);
      console.log("[Firestore] Cursos:", snap.docs.map((d) => d.data()));
      callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    (error) => {
      console.error("[Firestore] Erro em listenCursos:", error.code, error.message);
    }
  );
}

export function listenEventos(cursoId, callback) {
  console.log(`[Firestore] listenEventos: cursoId=${cursoId}`);
  const ref = collection(db, "cursos", cursoId, "eventos");
  return onSnapshot(
    query(ref, where("ativo", "==", true), orderBy("data")),
    (snap) => {
      console.log(`[Firestore] Eventos encontrados (curso ${cursoId}):`, snap.size);
      callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    (error) => {
      console.error("[Firestore] Erro em listenEventos:", error.code, error.message);
    }
  );
}

export function listenEncerrados(cursoId, callback) {
  console.log(`[Firestore] listenEncerrados: cursoId=${cursoId}`);
  const ref = collection(db, "cursos", cursoId, "eventos");
  return onSnapshot(
    query(ref, where("encerrado", "==", true)),
    (snap) => {
      console.log(`[Firestore] Encerrados encontrados (curso ${cursoId}):`, snap.size);
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

export function listenInscritos(cursoId, eventoId, callback) {
  console.log(`[Firestore] listenInscritos: cursoId=${cursoId} eventoId=${eventoId}`);
  const ref = collection(db, "cursos", cursoId, "eventos", eventoId, "inscritos");
  return onSnapshot(
    query(ref, orderBy("dataCompra", "desc")),
    (snap) => {
      console.log(`[Firestore] Inscritos encontrados (evento ${eventoId}):`, snap.size);
      callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    (error) => {
      console.error("[Firestore] Erro em listenInscritos:", error.code, error.message);
    }
  );
}

export function updateInscrito(cursoId, eventoId, inscritoId, patch) {
  const ref = doc(db, "cursos", cursoId, "eventos", eventoId, "inscritos", inscritoId);
  return updateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
}

export function updateEvento(cursoId, eventoId, patch) {
  const ref = doc(db, "cursos", cursoId, "eventos", eventoId);
  return updateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
}

export function updateCurso(cursoId, patch) {
  const ref = doc(db, "cursos", cursoId);
  return updateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
}