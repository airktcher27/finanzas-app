import assert from 'node:assert/strict';
import { parseAmount, formatMoney, toInput } from './money.js';
import { accountBalances, filterMovs, monthTotals, netSummary, shiftMonth, todayStr } from './ledger.js';

let n = 0;
const ok = (s) => console.log(`  ok ${++n}. ${s}`);

// --- parseAmount ---
const p = (s, c, o) => parseAmount(s, c, o);
assert.equal(p('12.500', 'COP'), 12500);
assert.equal(p('12,500', 'COP'), 12500);
assert.equal(p('1.234.567', 'COP'), 1234567);
assert.equal(p('$ 5000', 'COP'), 5000);
assert.equal(p('12.500,50', 'COP'), 12501);
assert.equal(p('abc', 'COP'), null);
assert.equal(p('', 'COP'), null);
ok('parseAmount COP: miles con punto o coma, símbolos, vacío');
assert.equal(p('12.50', 'USD'), 1250);
assert.equal(p('12,5', 'USD'), 1250);
assert.equal(p('1,234.56', 'USD'), 123456);
assert.equal(p('1.234,56', 'USD'), 123456);
assert.equal(p('1234', 'USD'), 123400);
assert.equal(p('0,99', 'USD'), 99);
assert.equal(p('1234.56', 'USD'), 123456);
assert.equal(p('-50', 'COP', { signed: true }), -50);
assert.equal(p('-50', 'COP'), 50);
ok('parseAmount USD: ambos formatos decimales y signo opcional');

// --- formatMoney / toInput ---
assert.match(formatMoney(12500, 'COP').replace(/\s/g, ' '), /12\.500/);
assert.match(formatMoney(1250, 'USD').replace(/\s/g, ' '), /12,50/);
assert.equal(toInput(12500, 'COP'), '12500');
assert.equal(toInput(1250, 'USD'), '12.50');
ok('formato y campo de edición');

// --- saldos ---
const accounts = [
  { id: 'nequi', name: 'Nequi', type: 'billetera', currency: 'COP', openingBalance: 100000 },
  { id: 'cred', name: 'Crédito', type: 'credito', currency: 'COP', openingBalance: -50000 },
  { id: 'hapi', name: 'Hapi', type: 'inversion', currency: 'USD', openingBalance: 10000 },
  { id: 'old', name: 'Vieja', type: 'debito', currency: 'COP', openingBalance: 5, archived: true },
];
const movs = [
  { id: '1', kind: 'gasto', date: '2026-11-03', accountId: 'nequi', amount: 20000, createdAt: 1 },
  { id: '2', kind: 'ingreso', date: '2026-11-05', accountId: 'nequi', amount: 500000, createdAt: 2 },
  { id: '3', kind: 'gasto', date: '2026-11-06', accountId: 'cred', amount: 30000, createdAt: 3 },
  { id: '4', kind: 'transferencia', date: '2026-11-07', accountId: 'nequi', toAccountId: 'cred', amount: 40000, toAmount: 40000, createdAt: 4 },
  { id: '5', kind: 'transferencia', date: '2026-11-08', accountId: 'nequi', toAccountId: 'hapi', amount: 400000, toAmount: 10000, createdAt: 5 },
  { id: '6', kind: 'gasto', date: '2026-10-30', accountId: 'nequi', amount: 999, createdAt: 6 },
  { id: '7', kind: 'gasto', date: '2026-11-09', accountId: 'cuenta-borrada', amount: 777, createdAt: 7 },
];
const bal = accountBalances(accounts, movs);
assert.equal(bal.get('nequi'), 100000 - 20000 + 500000 - 40000 - 400000 - 999);
assert.equal(bal.get('cred'), -50000 - 30000 + 40000);
assert.equal(bal.get('hapi'), 10000 + 10000);
assert.equal(bal.get('old'), 5);
ok('saldos: gastos, ingresos, pagos de tarjeta y transferencia COP→USD; ignora cuentas inexistentes');

// --- totales del mes ---
const byId = new Map(accounts.map((a) => [a.id, a]));
const t = monthTotals(movs, byId, '2026-11');
assert.deepEqual(t, { COP: { ingresos: 500000, gastos: 50000 } });
assert.deepEqual(monthTotals(movs, byId, '2026-11', 'cred'), { COP: { ingresos: 0, gastos: 30000 } });
ok('totales del mes excluyen transferencias y respetan el filtro de cuenta');

// --- filtros ---
const f = filterMovs(movs, { month: '2026-11', accountId: 'cred' });
assert.deepEqual(f.map((m) => m.id), ['4', '3']);
const all = filterMovs(movs, { month: '2026-11' });
assert.equal(all[0].id, '7');
assert.equal(all.length, 6);
ok('filtro por mes y cuenta (incluye transferencias de entrada) y orden por fecha');

// --- resumen ---
const ns = netSummary(accounts, bal);
assert.equal(ns.COP.cards, -40000);
assert.equal(ns.COP.assets, bal.get('nequi'));
assert.equal(ns.COP.net, bal.get('nequi') - 40000);
assert.equal(ns.USD.assets, 20000);
ok('resumen por moneda: disponible, tarjetas y neto (sin archivadas)');

// --- fechas ---
assert.equal(shiftMonth('2026-01', -1), '2025-12');
assert.equal(shiftMonth('2026-12', 1), '2027-01');
assert.equal(todayStr(new Date(2026, 10, 5)), '2026-11-05');
ok('navegación de meses y fecha local');

// --- deudas ---
import { debtFlows, debtRemaining, debtIsDone, debtTotals, addDays } from './ledger.js';
const debts = [
  { id: 'd1', dir: 'me-deben', person: 'Juan', currency: 'COP', amount: 100000, date: '2026-11-10', accountId: 'nequi', createdAt: 10 },
  { id: 'd2', dir: 'debo', person: 'Banco', currency: 'COP', amount: 500000, date: '2026-11-11', accountId: 'nequi', createdAt: 11 },
  { id: 'd3', dir: 'me-deben', person: 'Ana', currency: 'USD', amount: 5000, date: '2026-11-12', accountId: '', createdAt: 12 },
  { id: 'd4', dir: 'me-deben', person: 'Pedro', currency: 'COP', amount: 80000, date: '2026-11-01', accountId: '', closed: true, createdAt: 13 },
  { id: 'd5', dir: 'me-deben', person: 'Luis', currency: 'COP', amount: 20000, date: '2026-11-02', accountId: '', createdAt: 14 },
];
const abonos = [
  { id: 'a1', debtId: 'd1', amount: 30000, date: '2026-11-15', accountId: 'nequi', createdAt: 20 },
  { id: 'a2', debtId: 'd2', amount: 100000, date: '2026-11-16', accountId: 'nequi', createdAt: 21 },
  { id: 'a3', debtId: 'd5', amount: 20000, date: '2026-11-17', accountId: '', createdAt: 22 },
  { id: 'a4', debtId: 'no-existe', amount: 999, date: '2026-11-17', accountId: 'nequi', createdAt: 23 },
];
assert.equal(debtRemaining(debts[0], abonos), 70000);
assert.equal(debtRemaining(debts[4], abonos), 0);
assert.equal(debtIsDone(debts[3], abonos), true); // cerrada a mano
assert.equal(debtIsDone(debts[4], abonos), true); // pagada del todo
assert.equal(debtIsDone(debts[0], abonos), false);
ok('deuda pendiente, saldada por abonos o cerrada a mano');

const flows = debtFlows(debts, abonos);
assert.equal(flows.length, 4); // d1, d2, a1, a2 (a3 sin cuenta, a4 huérfano, d3/d4/d5 sin cuenta)
const bal2 = accountBalances(accounts, movs, flows);
assert.equal(bal2.get('nequi'), bal.get('nequi') - 100000 + 500000 + 30000 - 100000);
assert.equal(bal2.get('cred'), bal.get('cred'));
ok('préstamo hecho/recibido y abonos mueven el saldo de la cuenta; huérfanos y sin cuenta no');

const dt = debtTotals(debts, abonos);
assert.deepEqual(dt, { COP: { toMe: 70000, iOwe: 400000 }, USD: { toMe: 5000, iOwe: 0 } });
ok('totales pendientes por moneda excluyen saldadas y cerradas');

const ns2 = netSummary(accounts, bal2, dt);
assert.equal(ns2.COP.toMe, 70000);
assert.equal(ns2.COP.iOwe, 400000);
assert.equal(ns2.COP.net, bal2.get('nequi') - 40000 + 70000 - 400000);
assert.equal(ns2.USD.toMe, 5000);
assert.equal(ns2.USD.net, 20000 + 5000);
assert.equal(netSummary(accounts, bal).COP.toMe, 0);
ok('neto incluye lo que te deben y lo que debes');

assert.equal(addDays('2026-11-28', 5), '2026-12-03');
assert.equal(addDays('2026-12-30', 3), '2027-01-02');
ok('suma de días');

console.log(`\nTodas las pruebas pasaron (${n}).`);
