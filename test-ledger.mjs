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

console.log(`\nTodas las pruebas pasaron (${n}).`);
