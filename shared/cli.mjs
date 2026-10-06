// Convenção dos scripts que gravam: sem --apply é SIMULAÇÃO (lista o que seria
// gravado, não grava nada); a gravação só acontece com --apply.
export const APPLY = process.argv.includes('--apply');

// Chamar no fim de toda execução (antes de process.exit) — só imprime em simulação.
export function avisoSimulacao() {
  if (!APPLY) console.log('\nSIMULAÇÃO: nada foi gravado. Use --apply para gravar.');
}
