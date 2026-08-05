/**
 * Verificação temporária: confirma que o domínio usado como remetente
 * (ALERT_EMAIL_FROM em scripts/reconciliacao-pedidos.mjs) está verificado
 * na conta Resend, antes de ativar o cron de reconciliação de pedidos.
 *
 * Nunca imprime o valor de RESEND_API_KEY — só nome/status/região dos domínios.
 * Remover este arquivo e o step correspondente no workflow depois da validação.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DOMINIO_ESPERADO = 'smartgr.com.br';

if (!RESEND_API_KEY) {
  console.error('RESEND_API_KEY não definido no ambiente.');
  process.exit(1);
}

let resp;
try {
  resp = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
} catch (e) {
  console.error(`Erro de rede ao consultar a API do Resend: ${e.message}`);
  process.exit(1);
}

const body = await resp.json().catch(() => ({}));

if (!resp.ok) {
  console.error(`Falha ao consultar domínios Resend: HTTP ${resp.status} — ${body.message || 'erro desconhecido'}`);
  process.exit(1);
}

const dominios = body.data || [];
if (dominios.length === 0) {
  console.error('Nenhum domínio cadastrado nesta conta Resend.');
  process.exit(1);
}

console.log('Domínios cadastrados na conta Resend:');
for (const d of dominios) {
  console.log(`  ${d.name} | status: ${d.status} | region: ${d.region}`);
}

const alvo = dominios.find(d => d.name === DOMINIO_ESPERADO);
if (!alvo) {
  console.error(`\nAVISO: domínio "${DOMINIO_ESPERADO}" não encontrado nesta conta Resend — o envio de alerta vai falhar.`);
  process.exit(1);
}

if (alvo.status !== 'verified') {
  console.error(`\nAVISO: domínio "${DOMINIO_ESPERADO}" está com status "${alvo.status}" (não verificado) — o envio de alerta vai falhar.`);
  process.exit(1);
}

console.log(`\nDomínio "${DOMINIO_ESPERADO}" verificado — OK para enviar e-mails de alerta.`);
