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

// `flows` son los movimientos de dinero que generan las deudas y sus abonos (ver debtFlows).
export function accountBalances(accounts, movs, flows = []) {
  const bal = new Map(accounts.map((a) => [a.id, a.openingBalance || 0]));
  const add = (id, v) => {
    if (bal.has(id)) bal.set(id, bal.get(id) + v);
  };
  for (const f of flows) add(f.accountId, f.effect);
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

// Por moneda: disponible (cuentas normales), tarjetas (saldo de crédito, negativo = deuda),
// lo que te deben (toMe), lo que debes en préstamos (iOwe) y el neto de todo.
export function netSummary(accounts, balances, debtTot = {}) {
  const out = {};
  const slot = (cur) => (out[cur] ||= { assets: 0, cards: 0, toMe: 0, iOwe: 0, net: 0 });
  for (const a of accounts) {
    if (a.archived) continue;
    const t = slot(a.currency);
    const b = balances.get(a.id) || 0;
    if (a.type === 'credito') t.cards += b;
    else t.assets += b;
    t.net += b;
  }
  for (const [cur, d] of Object.entries(debtTot)) {
    const t = slot(cur);
    t.toMe = d.toMe;
    t.iOwe = d.iOwe;
    t.net += d.toMe - d.iOwe;
  }
  return out;
}

// ---------- Deudas ----------
// deuda: { dir: 'me-deben' | 'debo', person, currency, amount, date, dueDate, accountId, closed }
// abono: { debtId, amount, date, accountId }
// Si la deuda o el abono tienen cuenta, mueven el saldo de esa cuenta:
//   te prestaste/prestaste: sale dinero (−) · te prestaron: entra (+)
//   te pagan un abono: entra (+) · tú pagas un abono: sale (−)
export function debtFlows(debts, abonos) {
  const byId = new Map(debts.map((d) => [d.id, d]));
  const out = [];
  for (const d of debts) {
    if (!d.accountId) continue;
    out.push({
      id: 'd:' + d.id, kind: 'deuda', debtId: d.id, date: d.date, accountId: d.accountId,
      effect: d.dir === 'debo' ? d.amount : -d.amount,
      label: d.dir === 'debo' ? `Préstamo de ${d.person}` : `Préstamo a ${d.person}`,
      createdAt: d.createdAt || 0,
    });
  }
  for (const a of abonos) {
    const d = byId.get(a.debtId);
    if (!d || !a.accountId) continue;
    out.push({
      id: 'a:' + a.id, kind: 'abono', debtId: d.id, date: a.date, accountId: a.accountId,
      effect: d.dir === 'debo' ? -a.amount : a.amount,
      label: d.dir === 'debo' ? `Pago a ${d.person}` : `Abono de ${d.person}`,
      createdAt: a.createdAt || 0,
    });
  }
  return out;
}

export function debtRemaining(debt, abonos) {
  let paid = 0;
  for (const a of abonos) if (a.debtId === debt.id) paid += a.amount;
  return debt.amount - paid;
}

export const debtIsDone = (debt, abonos) => !!debt.closed || debtRemaining(debt, abonos) <= 0;

// Pendiente por moneda: lo que te deben y lo que debes.
export function debtTotals(debts, abonos) {
  const out = {};
  for (const d of debts) {
    if (debtIsDone(d, abonos)) continue;
    const t = (out[d.currency] ||= { toMe: 0, iOwe: 0 });
    const rem = debtRemaining(d, abonos);
    if (d.dir === 'debo') t.iOwe += rem;
    else t.toMe += rem;
  }
  return out;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return todayStr(new Date(y, m - 1, d + n));
}
