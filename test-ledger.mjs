import assert from 'node:assert/strict';
import { parseAmount, formatMoney, toInput } from './money.js';
import { trashGroups, purgeable, restorePlan, versionSummary } from './trash.js';
import { installmentPlan, interestMovs, unbilledPrincipal, activeInstallments, hasCuotas } from './ledger.js';
import { searchMovs, listTotals, fold } from './ledger.js';
import { debtsByPerson, personKey, accountBalances, filterMovs, monthTotals, netSummary, shiftMonth, todayStr } from './ledger.js';

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


// --- tarjetas: corte y pago ---
import { cardCycle, nextDayOnOrAfter, prevDayBefore } from './ledger.js';
assert.equal(nextDayOnOrAfter('2026-11-22', 14), '2026-12-14');
assert.equal(nextDayOnOrAfter('2026-11-10', 14), '2026-11-14');
assert.equal(nextDayOnOrAfter('2026-11-14', 14), '2026-11-14');
assert.equal(nextDayOnOrAfter('2027-02-10', 31), '2027-02-28');
assert.equal(prevDayBefore('2026-12-14', 24), '2026-11-24');
assert.equal(prevDayBefore('2026-01-14', 24), '2025-12-24');
assert.equal(prevDayBefore('2026-11-20', 5), '2026-11-05');
ok('fechas de corte y pago: siguiente/anterior, fin de año y meses cortos');

const card = { id: 'nu', type: 'credito', currency: 'COP', openingBalance: -50000, cutDay: 24, payDay: 14 };
const cmovs = [
  { id: 'c1', kind: 'transferencia', date: '2026-11-05', accountId: 'nequi', toAccountId: 'nu', amount: 20000, toAmount: 20000 },
  { id: 'c2', kind: 'gasto', date: '2026-11-10', accountId: 'nu', amount: 30000 },
];
// Antes del pago del 14: el corte (24 oct) ya pasó -> extracto fijo
let cy = cardCycle(card, cmovs, [], '2026-11-10');
assert.equal(cy.due, '2026-11-14');
assert.equal(cy.cut, '2026-10-24');
assert.equal(cy.cutPassed, true);
assert.equal(cy.toPay, 30000); // deuda al corte 50.000 - 20.000 abonados; la compra del 10 va al siguiente
assert.equal(cy.newCharges, 30000);
assert.equal(cy.nextCut, '2026-11-24');
// Después del pago del 14 y antes del corte del 24: estimado del siguiente
cy = cardCycle(card, cmovs, [], '2026-11-22');
assert.equal(cy.due, '2026-12-14');
assert.equal(cy.cut, '2026-11-24');
assert.equal(cy.cutPassed, false);
assert.equal(cy.estimate, true);
assert.equal(cy.toPay, 60000); // -50.000 + 20.000 - 30.000 = -60.000
// El día del corte ya cuenta como extracto cerrado
cy = cardCycle(card, cmovs, [], '2026-11-24');
assert.equal(cy.cutPassed, true);
assert.equal(cy.toPay, 60000);
// Sin días configurados -> sin ciclo
assert.equal(cardCycle({ ...card, cutDay: null }, cmovs, [], '2026-11-10'), null);
// Pagó de más: no hay nada por pagar
const cmovs2 = [...cmovs, { id: 'c3', kind: 'transferencia', date: '2026-11-12', accountId: 'nequi', toAccountId: 'nu', amount: 90000, toAmount: 90000 }];
assert.equal(cardCycle(card, cmovs2, [], '2026-11-13').toPay, 0);
ok('ciclo de tarjeta: extracto fijo tras el corte, estimado antes, pagos posteriores y sin configurar');


// --- reportes ---
import { categoryTotals, lastMonths, monthEnd, monthSeries, earliestDate, netWorthAt, budgetState, niceTicks } from './ledger.js';
const rmovs = [
  { id: 'r1', kind: 'gasto', date: '2026-11-03', accountId: 'nequi', amount: 60000, categoryId: 'comida', createdAt: 1 },
  { id: 'r2', kind: 'gasto', date: '2026-11-04', accountId: 'nequi', amount: 15000, categoryId: 'comida', createdAt: 2 },
  { id: 'r3', kind: 'gasto', date: '2026-11-05', accountId: 'nequi', amount: 20000, categoryId: '', createdAt: 3 },
  { id: 'r4', kind: 'gasto', date: '2026-10-15', accountId: 'nequi', amount: 30000, categoryId: 'comida', createdAt: 4 },
  { id: 'r5', kind: 'gasto', date: '2026-11-06', accountId: 'hapi', amount: 500, categoryId: 'ocio', createdAt: 5 },
  { id: 'r6', kind: 'ingreso', date: '2026-11-07', accountId: 'nequi', amount: 300000, categoryId: 'sueldo', createdAt: 6 },
];
const ct = categoryTotals(rmovs, byId, '2026-11', 'COP');
assert.equal(ct.get('comida'), 75000);
assert.equal(ct.get(''), 20000);
assert.equal(ct.has('ocio'), false); // esa es en USD
assert.equal(categoryTotals(rmovs, byId, '2026-11', 'USD').get('ocio'), 500);
assert.equal(categoryTotals(rmovs, byId, '2026-11', 'COP', 'ingreso').get('sueldo'), 300000);
ok('totales por categoría: filtra por mes, moneda y tipo; "" = sin categoría');

assert.deepEqual(lastMonths('2026-02', 4), ['2025-11', '2025-12', '2026-01', '2026-02']);
assert.equal(monthEnd('2026-02'), '2026-02-28');
assert.equal(monthEnd('2026-11'), '2026-11-30');
const ser = monthSeries(rmovs, byId, ['2026-10', '2026-11'], 'COP');
assert.deepEqual(ser, [
  { month: '2026-10', ingresos: 0, gastos: 30000 },
  { month: '2026-11', ingresos: 300000, gastos: 95000 },
]);
ok('serie mensual de ingresos y gastos y fin de mes');

assert.equal(earliestDate([], rmovs, [], []), '2026-10-15');
assert.equal(earliestDate([], [], [], []), null);
ok('fecha más antigua con datos');

// Patrimonio en el tiempo: cuenta con saldo inicial 100.000, un gasto el 10/oct y un ingreso el 5/nov.
const nwAcc = [{ id: 'x', type: 'debito', currency: 'COP', openingBalance: 100000, createdAt: new Date(2026, 9, 1).getTime() }];
const nwMovs = [
  { id: 'n1', kind: 'gasto', date: '2026-10-10', accountId: 'x', amount: 30000 },
  { id: 'n2', kind: 'ingreso', date: '2026-11-05', accountId: 'x', amount: 50000 },
];
const nwDebts = [{ id: 'dd', dir: 'me-deben', person: 'Z', currency: 'COP', amount: 40000, date: '2026-10-20', accountId: '', closed: false }];
const nwAbonos = [{ id: 'aa', debtId: 'dd', amount: 10000, date: '2026-11-02', accountId: '' }];
assert.deepEqual(netWorthAt(nwAcc, nwMovs, [], nwDebts, nwAbonos, '2026-09-30'), {}); // antes de existir
assert.deepEqual(netWorthAt(nwAcc, nwMovs, [], nwDebts, nwAbonos, '2026-10-15'), { COP: 70000 });
assert.deepEqual(netWorthAt(nwAcc, nwMovs, [], nwDebts, nwAbonos, '2026-10-31'), { COP: 70000 + 40000 });
assert.deepEqual(netWorthAt(nwAcc, nwMovs, [], nwDebts, nwAbonos, '2026-11-30'), { COP: 120000 + 30000 });
// deuda cerrada a mano desde una fecha: deja de contar desde ese día
const closedDebts = [{ ...nwDebts[0], closed: true, closedAt: '2026-11-03' }];
assert.deepEqual(netWorthAt(nwAcc, nwMovs, [], closedDebts, nwAbonos, '2026-11-02'), { COP: 70000 + 40000 - 10000 });
assert.deepEqual(netWorthAt(nwAcc, nwMovs, [], closedDebts, nwAbonos, '2026-11-30'), { COP: 120000 });
ok('patrimonio en el tiempo: cuentas desde que existen, deudas con abonos y cierre a mano');

// Coincide con el resumen de hoy
const todayAll = netWorthAt(accounts, movs, flows, debts, abonos, '2099-01-01');
const nsAll = netSummary(accounts, accountBalances(accounts, movs, flows), debtTotals(debts, abonos));
assert.equal(todayAll.COP, nsAll.COP.net);
assert.equal(todayAll.USD, nsAll.USD.net);
ok('el patrimonio de hoy coincide con el neto del Resumen');

assert.equal(budgetState(40000, 100000).state, 'ok');
assert.equal(budgetState(80000, 100000).state, 'warn');
assert.equal(budgetState(100000, 100000).state, 'warn');
assert.equal(budgetState(110000, 100000).state, 'over');
assert.equal(budgetState(110000, 100000).left, -10000);
assert.equal(budgetState(5, 0), null);
ok('estado del presupuesto: ok, cerca y excedido');

assert.deepEqual(niceTicks(0, 95000, 4), [0, 50000, 100000]);
assert.deepEqual(niceTicks(0, 300000, 4), [0, 100000, 200000, 300000]);
assert.deepEqual(niceTicks(-50, 120, 4), [-50, 0, 50, 100, 150]);
assert.deepEqual(niceTicks(0, 0, 4), [0, 1]);
ok('marcas redondas para los ejes');


// --- puntos del patrimonio ---
import { netWorthPoints } from './ledger.js';
const pa = [{ id: 'p', type: 'debito', currency: 'COP', openingBalance: 100000, createdAt: new Date(2026, 8, 10).getTime() }];
const pm = [{ id: 'q1', kind: 'ingreso', date: '2026-10-05', accountId: 'p', amount: 50000 }];
let pts = netWorthPoints(pa, pm, [], [], [], 'COP', '2026-11-22', 6);
assert.deepEqual(pts.map((x) => x.date), ['2026-09-10', '2026-09-30', '2026-10-31', '2026-11-22']);
assert.deepEqual(pts.map((x) => x.value), [100000, 100000, 150000, 150000]);
// historial de un solo día: un punto (el caller muestra el aviso)
pts = netWorthPoints(pa, [], [], [], [], 'COP', '2026-09-10', 6);
assert.equal(pts.length, 1);
// moneda sin cuentas: sin puntos
assert.deepEqual(netWorthPoints(pa, pm, [], [], [], 'USD', '2026-11-22', 6), []);
// historial largo: solo los últimos 6 meses (5 fines de mes + hoy)
const oldAcc = [{ ...pa[0], createdAt: new Date(2025, 0, 1).getTime() }];
pts = netWorthPoints(oldAcc, [], [], [], [], 'COP', '2026-11-22', 6);
assert.equal(pts.length, 6);
assert.equal(pts[0].date, '2026-06-30');
assert.equal(pts[5].date, '2026-11-22');
ok('puntos del patrimonio: primer dato, fines de mes, hoy y límite de 6 meses');


// --- ahorro (cajita) ---
import { savingsMonth, savingsYear, goalTargets, yearNeeded } from './ledger.js';
const smovs = [
  { id: 's1', kind: 'transferencia', date: '2026-11-02', accountId: 'nequi', toAccountId: 'caj', amount: 200000, toAmount: 200000 },
  { id: 's2', kind: 'transferencia', date: '2026-11-20', accountId: 'nequi', toAccountId: 'caj', amount: 100000, toAmount: 100000 },
  { id: 's3', kind: 'transferencia', date: '2026-11-25', accountId: 'caj', toAccountId: 'nequi', amount: 50000, toAmount: 50000 },
  { id: 's4', kind: 'ingreso', date: '2026-11-30', accountId: 'caj', amount: 1500 },
  { id: 's5', kind: 'gasto', date: '2026-10-05', accountId: 'caj', amount: 20000 },
  { id: 's6', kind: 'transferencia', date: '2026-10-06', accountId: 'nequi', toAccountId: 'caj', amount: 400000, toAmount: 400000 },
  { id: 's7', kind: 'transferencia', date: '2026-11-08', accountId: 'nequi', toAccountId: 'otra', amount: 999, toAmount: 999 },
];
assert.deepEqual(savingsMonth('caj', smovs, '2026-11'), { aportes: 250000, rendimientos: 1500 });
assert.deepEqual(savingsMonth('caj', smovs, '2026-10'), { aportes: 380000, rendimientos: 0 });
assert.deepEqual(savingsMonth('caj', smovs, '2026-09'), { aportes: 0, rendimientos: 0 });
ok('aportes netos: entran transferencias, salen retiros y gastos; rendimientos aparte');
// transferencia desde otra moneda: cuenta lo que recibe la cajita
assert.equal(savingsMonth('caj', [{ kind: 'transferencia', date: '2026-11-03', accountId: 'hapi', toAccountId: 'caj', amount: 10000, toAmount: 400000 }], '2026-11').aportes, 400000);
ok('aporte desde otra moneda cuenta el monto recibido');
const sy = savingsYear('caj', smovs, 2026);
assert.equal(sy.length, 12);
assert.equal(sy[0].month, '2026-01');
assert.equal(sy[10].aportes, 250000);
assert.equal(sy.reduce((a, x) => a + x.aportes, 0), 630000);
ok('año completo: 12 meses y total del año');
assert.deepEqual(goalTargets({ monthly: 300000, annual: 0 }), { monthly: 300000, annual: 3600000 });
assert.deepEqual(goalTargets({ monthly: 0, annual: 2400000 }), { monthly: 200000, annual: 2400000 });
assert.deepEqual(goalTargets({ monthly: 300000, annual: 4000000 }), { monthly: 300000, annual: 4000000 });
ok('metas efectivas: se deduce la que falta');
// En noviembre con 300.000 ahorrados de 3.600.000: faltan 3.300.000 en noviembre y diciembre
assert.deepEqual(yearNeeded(3600000, 300000, '2026-11-22', false), { left: 2, missing: 3300000, perMonth: 1650000 });
// Si noviembre ya cumplió su meta, solo queda diciembre
assert.deepEqual(yearNeeded(3600000, 300000, '2026-11-22', true), { left: 1, missing: 3300000, perMonth: 3300000 });
// A inicio de año con el mes pendiente: 12 meses
assert.deepEqual(yearNeeded(1200000, 0, '2026-01-05', false), { left: 12, missing: 1200000, perMonth: 100000 });
// Redondea hacia arriba y no baja de cero
assert.equal(yearNeeded(1000, 0, '2026-10-01', false).perMonth, 334); // 3 meses: 1000/3 = 333,3 → 334
assert.equal(yearNeeded(1000, 0, '2026-09-01', false).perMonth, 250); // 4 meses
assert.equal(yearNeeded(1000, 5000, '2026-06-01', false).perMonth, 0);
// Diciembre ya cumplido: sin meses restantes, lo que falta queda tal cual
assert.deepEqual(yearNeeded(1200000, 1000000, '2026-12-20', true), { left: 0, missing: 200000, perMonth: 200000 });
ok('cuánto ahorrar al mes hasta diciembre para llegar a la meta anual');

// --- deudas por persona ---
assert.equal(personKey('  JUÁN  Pérez '), 'juan perez');
const dd = [
  { id: 'a', person: 'Juan', dir: 'me-deben', currency: 'COP', amount: 100000 },
  { id: 'b', person: ' juan ', dir: 'debo', currency: 'COP', amount: 30000 },
  { id: 'c', person: 'Ana', dir: 'me-deben', currency: 'USD', amount: 5000 },
  { id: 'd', person: 'Ana', dir: 'me-deben', currency: 'COP', amount: 20000, closed: true },
  { id: 'e', person: 'Luis', dir: 'debo', currency: 'COP', amount: 10000 },
];
const dab = [{ id: 'x', debtId: 'a', amount: 40000 }, { id: 'y', debtId: 'e', amount: 10000 }];
const byP = debtsByPerson(dd, dab);
assert.deepEqual(byP.map((q) => q.person), ['Ana', 'Juan']);
const juan = byP.find((q) => q.key === 'juan');
assert.deepEqual(juan.byCur.COP, { toMe: 60000, iOwe: 30000, net: 30000 });
assert.equal(juan.count, 2);
assert.deepEqual(byP.find((q) => q.key === 'ana').byCur, { USD: { toMe: 5000, iOwe: 0, net: 5000 } });
ok('deudas por persona: agrupa nombres iguales, descuenta abonos, ignora saldadas y separa monedas');

// --- papelera ---
{
  const now = Date.parse('2026-11-26T12:00:00Z');
  const day = 864e5;
  const all = [
    { col: 'movs', id: 'm1', amount: 5000, deleted: true, updatedAt: now - day },
    { col: 'cuentas', id: 'c1', name: 'Temporal', deleted: true, trash: 'g1', updatedAt: now - 2 * day },
    { col: 'movs', id: 'm2', amount: 100, deleted: true, trash: 'g1', updatedAt: now - 2 * day },
    { col: 'movs', id: 'm3', amount: 7, deleted: true, updatedAt: now - 40 * day },
    { col: 'movs', id: 'm4', deleted: true, updatedAt: now - day },                 // ya purgado: sin datos
    { col: 'presupuestos', id: 'b1', amount: 1, deleted: true, updatedAt: now },    // no se muestra
    { col: 'movs', id: 'm5', amount: 1, deleted: false, updatedAt: now },
  ];
  const g = trashGroups(all, now);
  assert.deepEqual(g.map((x) => x.key), ['movs/m1', 'g1']);
  assert.equal(g[1].main.col, 'cuentas');
  assert.equal(g[1].items.length, 2);
  assert.deepEqual(purgeable(all, now).map((r) => r.id), ['m3']);
  assert.deepEqual(purgeable(all, now)[0], { col: 'movs', id: 'm3', updatedAt: now - 40 * day, dev: undefined, deleted: true });
  assert.deepEqual(purgeable(all, now, true).map((r) => r.id).sort(), ['c1', 'm1', 'm2', 'm3']);
  ok('papelera: agrupa lo borrado junto, ignora lo vencido o ya purgado, y purga a los 30 días');
}
// --- restaurar versión ---
{
  const version = [
    { col: 'movs', id: 'a', amount: 1, deleted: false },
    { col: 'movs', id: 'b', amount: 2, deleted: true },
    { col: 'dispositivos', id: 'pc', version: 'viejo' },
    { col: 'config', id: 'compactacion', at: 1 },
  ];
  const current = [
    { col: 'movs', id: 'a', amount: 99, deleted: false },
    { col: 'movs', id: 'b', amount: 2, deleted: false },
    { col: 'movs', id: 'c', amount: 3, deleted: false },
    { col: 'movs', id: 'd', amount: 4, deleted: true },
    { col: 'dispositivos', id: 'pc', version: 'nuevo' },
  ];
  const plan = restorePlan(current, version);
  const by = Object.fromEntries(plan.map((r) => [`${r.col}/${r.id}`, r]));
  assert.equal(by['movs/a'].amount, 1);
  assert.equal(by['movs/b'].deleted, true);
  assert.equal(by['movs/c'].deleted, true);
  assert.equal(by['movs/d'], undefined);
  assert.equal(by['dispositivos/pc'], undefined);
  assert.equal(by['config/compactacion'], undefined);
  assert.deepEqual(versionSummary(version), { movs: 1, cuentas: 0, deudas: 0, inv: 0, metas: 0 });
  ok('restaurar versión: vuelve cada registro a como estaba, elimina lo creado después y no toca datos internos');
}

// --- compras a cuotas ---
{
  const card = { id: 'nu', type: 'credito', currency: 'COP', openingBalance: 0, cutDay: 24, payDay: 14, createdAt: 0 };
  const accById = new Map([['nu', card]]);
  // 1.200.000 a 12 cuotas sin interés, comprado el 10 de nov: primer corte 24 nov
  const m0 = { id: 'tv', kind: 'gasto', accountId: 'nu', amount: 1200000, date: '2026-11-10', cuotas: { n: 12, rate: 0 } };
  let plan = installmentPlan(m0, card);
  assert.equal(plan.rows.length, 12);
  assert.deepEqual(plan.rows.slice(0, 3).map((r) => r.cut), ['2026-11-24', '2026-12-24', '2027-01-24']);
  assert.ok(plan.rows.every((r) => r.capital === 100000 && r.interest === 0));
  // comprado el mismo día del corte: entra en ese corte
  assert.equal(installmentPlan({ ...m0, date: '2026-11-24' }, card).rows[0].cut, '2026-11-24');
  // con resto: 100.000 en 3 → 33.333, 33.333, 33.334
  assert.deepEqual(installmentPlan({ ...m0, amount: 100000, cuotas: { n: 3, rate: 0 } }, card).rows.map((r) => r.capital), [33333, 33333, 33334]);
  ok('cuotas sin interés: una por corte desde la compra, el resto en la última');

  // con interés 2 % mensual, 1.000.000 a 6 cuotas: cuota fija francesa ≈ 178.526
  const m1 = { id: 'cel', kind: 'gasto', accountId: 'nu', amount: 1000000, date: '2026-11-10', cuotas: { n: 6, rate: 0.02 } };
  plan = installmentPlan(m1, card);
  assert.equal(plan.cuota, 178526);
  assert.equal(plan.rows[0].interest, 20000);
  assert.equal(plan.rows.reduce((a, r) => a + r.capital, 0), 1000000);
  assert.ok(Math.abs(plan.rows[5].cuota - 178526) <= 2);
  ok('cuotas con interés: cuota fija, interés sobre el saldo y capital completo');

  // intereses facturados hasta hoy como gastos virtuales
  const today = '2026-12-30';
  const ints = interestMovs([m0, m1], accById, today);
  assert.deepEqual(ints.map((x) => [x.date, x.amount]), [['2026-11-24', 20000], ['2026-12-24', plan.rows[1].interest]]);
  assert.ok(ints.every((x) => x.virtual && x.categoryId === 'cat-g-intereses'));
  ok('los intereses de cada corte ya pasado cuentan como gasto en la tarjeta');

  // capital sin facturar
  assert.equal(unbilledPrincipal([m0], card, '2026-12-30', '2026-12-24'), 1000000);
  assert.equal(unbilledPrincipal([m0], card, '2026-11-01', '2026-12-24'), 0, 'compras posteriores no cuentan');

  // pago de la tarjeta: corte 24 dic ya pasó, pago el 14 ene → toca pagar 2 cuotas de la tv (nov+dic)? No: el
  // extracto de dic incluye lo facturado hasta el 24 dic menos lo pagado: 2 cuotas de 100.000 (nov y dic)
  const c = cardCycle(card, [m0], [], today);
  assert.equal(c.cut, '2026-12-24');
  assert.equal(c.toPay, 200000);
  // pagaste la cuota de noviembre el 10 de dic → queda la de diciembre
  const pago = { id: 'p', kind: 'transferencia', accountId: 'x', toAccountId: 'nu', amount: 100000, date: '2026-12-10' };
  assert.equal(cardCycle(card, [m0, pago], [], today).toPay, 100000);
  // antes del corte (16 dic): estimado = solo las cuotas que llegan en el corte del 24 dic
  const e = cardCycle(card, [m0, pago], [], '2026-12-16');
  assert.equal(e.estimate, true);
  assert.equal(e.toPay, 100000);
  // con interés: el estimado incluye el interés que se cobra en ese corte
  const e2 = cardCycle(card, [m1, ...interestMovs([m1], accById, '2026-12-16')], [], '2026-12-16');
  assert.equal(e2.toPay, plan.rows[0].cuota + plan.rows[1].capital + plan.rows[1].interest);
  ok('pago de la tarjeta: solo las cuotas facturadas (y su interés), no el total de la compra');

  const act = activeInstallments([m0, m1, { ...m0, id: 'x', cuotas: { n: 1 } }], accById, today);
  assert.deepEqual(act.map((a) => [a.mov.id, a.billedCount, a.next.cut]), [['tv', 2, '2027-01-24'], ['cel', 2, '2027-01-24']]);
  assert.equal(act[0].remainingCapital, 1000000);
  assert.equal(hasCuotas({ ...m0, cuotas: { n: 1 } }), false);
  ok('cuotas activas: cuántas van, la próxima y lo que falta');
}

// --- búsqueda ---
{
  const accById = new Map([['n', { id: 'n', name: 'Nequi', currency: 'COP' }], ['h', { id: 'h', name: 'Hapi', currency: 'USD' }]]);
  const catById = new Map([['c1', { id: 'c1', name: 'Comida y restaurantes' }], ['c2', { id: 'c2', name: 'Transporte' }]]);
  const L = [
    { id: '1', kind: 'gasto', accountId: 'n', amount: 12500, categoryId: 'c1', note: 'Almuerzo en el Rápido', date: '2026-11-01' },
    { id: '2', kind: 'gasto', accountId: 'n', amount: 9000, categoryId: 'c2', note: 'Uber', date: '2026-10-15' },
    { id: '3', kind: 'ingreso', accountId: 'n', amount: 500000, categoryId: '', note: '', date: '2026-11-02' },
    { id: '4', kind: 'transferencia', accountId: 'n', toAccountId: 'h', amount: 400000, toAmount: 10000, note: 'Pasar a Hapi', date: '2026-11-03' },
    { id: '5', kind: 'gasto', accountId: 'h', amount: 1999, categoryId: '', note: 'Netflix', date: '2026-11-04' },
  ];
  const ctx = { catById, accById, dec: (c) => (c === 'USD' ? 2 : 0) };
  const ids = (o) => searchMovs(L, o, ctx).map((m) => m.id);
  assert.deepEqual(ids({ q: 'rapido' }), ['1'], 'sin tildes ni mayúsculas');
  assert.deepEqual(ids({ q: 'comida' }), ['1'], 'por categoría');
  assert.deepEqual(ids({ q: '12.500' }), ['1'], 'por monto con puntos');
  assert.deepEqual(ids({ q: '19' }), ['5'], 'monto en dólares por la parte entera');
  assert.deepEqual(ids({ q: 'hapi' }), ['5', '4'], 'por cuenta (origen o destino)');
  assert.deepEqual(ids({ kind: 'gasto', from: '2026-11-01', to: '2026-11-30' }), ['5', '1']);
  assert.deepEqual(ids({ categoryId: '-' }), ['5', '3'], 'sin categoría');
  assert.deepEqual(ids({ q: 'uber transporte' }), ['2'], 'todas las palabras');
  assert.deepEqual(ids({ accountId: 'h' }), ['5', '4']);
  const tot = listTotals(searchMovs(L, {}, ctx), accById);
  assert.deepEqual(tot.COP, { ingresos: 500000, gastos: 21500, n: 3 });
  assert.equal(fold('Ñandú'), 'nandu');
  ok('búsqueda: texto sin tildes, categoría, monto, cuenta, tipo, fechas y totales');
}

console.log(`\nTodas las pruebas pasaron (${n}).`);
