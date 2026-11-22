// Cálculos puros (sin navegador): saldos, totales del mes, filtros y resumen.
// Los saldos NO se guardan: se calculan = saldo inicial + movimientos.
// Así dos dispositivos nunca se pisan un número.

export const live = (recs, col) => recs.filter((r) => r.col === col && !r.deleted);

const pad = (n) => String(n).padStart(2, '0');

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const monthOf = (dateStr) => dateStr.slice(0, 7);

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function accountBalances(accounts, movs) {
  const bal = new Map(accounts.map((a) => [a.id, a.openingBalance || 0]));
  const add = (id, v) => {
    if (bal.has(id)) bal.set(id, bal.get(id) + v);
  };
  for (const m of movs) {
    if (m.kind === 'ingreso') add(m.accountId, m.amount);
    else if (m.kind === 'gasto') add(m.accountId, -m.amount);
    else if (m.kind === 'transferencia') {
      add(m.accountId, -m.amount);
      add(m.toAccountId, m.toAmount ?? m.amount);
    }
  }
  return bal;
}

export function filterMovs(movs, { month, accountId } = {}) {
  return movs
    .filter(
      (m) =>
        (!month || m.date.startsWith(month)) &&
        (!accountId || m.accountId === accountId || m.toAccountId === accountId)
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
}

// Ingresos y gastos del mes por moneda. Las transferencias no cuentan
// (pagar la tarjeta no es un gasto nuevo: el gasto ya se registró al comprar).
export function monthTotals(movs, accById, month, accountId) {
  const out = {};
  for (const m of movs) {
    if (!m.date.startsWith(month) || m.kind === 'transferencia') continue;
    if (accountId && m.accountId !== accountId) continue;
    const a = accById.get(m.accountId);
    if (!a) continue;
    const t = (out[a.currency] ||= { ingresos: 0, gastos: 0 });
    if (m.kind === 'ingreso') t.ingresos += m.amount;
    else if (m.kind === 'gasto') t.gastos += m.amount;
  }
  return out;
}

// Por moneda: disponible (cuentas normales), tarjetas (saldo de crédito, negativo = deuda) y neto.
export function netSummary(accounts, balances) {
  const out = {};
  for (const a of accounts) {
    if (a.archived) continue;
    const t = (out[a.currency] ||= { assets: 0, cards: 0, net: 0 });
    const b = balances.get(a.id) || 0;
    if (a.type === 'credito') t.cards += b;
    else t.assets += b;
    t.net += b;
  }
  return out;
}
