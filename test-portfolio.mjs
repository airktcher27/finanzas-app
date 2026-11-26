import assert from 'node:assert/strict';
import { closeOn, actualResult, benchmarkResult, sampleDates, historyLines, allocation, contributionPlan, OTHER } from './portfolio.js';
import { parseSeries, fetchSeries } from './prices.js';

let n = 0;
const ok = (s) => console.log(`  ok ${++n}. ${s}`);
let id = 0;
const op = (o) => ({ id: 'o' + ++id, createdAt: id, currency: 'USD', ...o });

// --- cierres ---
const voo = [['2026-01-02', 50000], ['2026-01-05', 51000], ['2026-02-02', 55000], ['2026-03-02', 60000]];
assert.equal(closeOn(voo, '2026-01-01'), null);
assert.equal(closeOn(voo, '2026-01-03'), 50000, 'fin de semana: el último cierre');
assert.equal(closeOn(voo, '2026-02-02'), 55000);
assert.equal(closeOn(voo, '2026-12-31'), 60000);
ok('cierre de un día (o el último hábil antes)');

// --- comparación ---
const ops = [
  op({ symbol: 'NVDA', kind: 'compra', date: '2026-01-02', qty: 1, amount: 100000 }),   // US$1000
  op({ symbol: 'NVDA', kind: 'compra', date: '2026-02-02', qty: 0.5, amount: 55000 }),  // US$550
  op({ symbol: 'NVDA', kind: 'venta', date: '2026-02-02', qty: 0.1, amount: 11000 }),   // saca US$110
  op({ symbol: 'NVDA', kind: 'dividendo', date: '2026-02-10', amount: 500 }),
  op({ symbol: 'NU', kind: 'compra', date: '2026-01-02', qty: 1, amount: 1000, currency: 'COP' }), // no cuenta
];
const mine = actualResult(ops, 170000);
assert.deepEqual([mine.invested, mine.withdrawn, mine.value, mine.gain], [155000, 11500, 170000, 26500]);
const b = benchmarkResult(ops, voo, '2026-03-02');
// VOO: 1000/500 = 2 acc; 550/550 = 1 acc; vende 110/550 = 0,2 → 2,8 acc × 600 = 1680
assert.equal(b.invested, 155000);
assert.equal(b.withdrawn, 11000);
assert.equal(b.value, 168000);
assert.equal(b.gain, 168000 + 11000 - 155000);
assert.ok(Math.abs(b.pct - 24000 / 155000) < 1e-9);
assert.equal(benchmarkResult([op({ symbol: 'X', kind: 'compra', date: '2025-12-01', qty: 1, amount: 100 })], voo, '2026-03-02'), null, 'sin precio ese día → no se inventa');
ok('comparar: el índice recibe las mismas compras y ventas el mismo día; tus dividendos cuentan para ti');

// --- historial ---
const dates = sampleDates('2026-01-02', '2026-03-02');
assert.equal(dates[0], '2026-01-02');
assert.equal(dates.at(-1), '2026-03-02');
assert.ok(dates.length >= 9 && dates.length <= 10);
const long = sampleDates('2020-01-01', '2026-01-01');
assert.ok(long.length <= 125, `muestra larga acotada (${long.length})`);
const nvda = [['2026-01-02', 100000], ['2026-02-02', 110000], ['2026-03-02', 120000]];
const lines = historyLines(ops, { NVDA: nvda, VOO: voo }, ['VOO'], ['2026-01-02', '2026-02-02', '2026-03-02']);
assert.deepEqual(lines.mine.map((p) => p.value), [100000, 154000, 168000]); // 1 / 1,4 / 1,4 acciones
assert.deepEqual(lines.bench.VOO.map((p) => p.value), [100000, 154000, 168000]);
const missing = historyLines(ops, { VOO: voo }, ['VOO'], ['2026-01-02']);
assert.equal(missing.mine[0].value, null);
ok('historial semanal: tu valor con las cantidades de cada fecha y el índice simulado');

// --- asignación ---
const rows = [{ symbol: 'VOO', value: 60000 }, { symbol: 'VXUS', value: 10000 }, { symbol: 'NVDA', value: 20000 }, { symbol: 'META', value: 10000 }];
const al = allocation(rows, [{ symbol: 'VOO', pct: 70 }, { symbol: 'VXUS', pct: 20 }]);
assert.equal(al.total, 100000);
assert.equal(al.rest, 10);
const by = Object.fromEntries(al.list.map((x) => [x.symbol, x]));
assert.deepEqual([by.VOO.actual, by.VOO.target, by.VOO.diff], [60, 70, -10]);
assert.deepEqual([by.VXUS.actual, by.VXUS.gapValue], [10, 10000]);
assert.deepEqual([by[OTHER].actual, by[OTHER].target, by[OTHER].members.sort().join()], [30, 10, 'META,NVDA']);
assert.deepEqual(al.list.map((x) => x.symbol), ['VOO', 'VXUS', OTHER]);
ok('asignación: actual vs objetivo, y lo que no tiene objetivo va a «Otras» con el % que sobra');

// --- aporte nuevo ---
let plan = contributionPlan(rows, [{ symbol: 'VOO', pct: 70 }, { symbol: 'VXUS', pct: 20 }], 20000);
// tras el aporte el total es 120.000: VOO debería 84.000 (falta 24.000), VXUS 24.000 (falta 14.000) → 38.000 > 20.000, se reparte proporcional
assert.equal(plan.reduce((a, p) => a + p.amount, 0), 20000);
const pv = Object.fromEntries(plan.map((p) => [p.symbol, p.amount]));
assert.ok(Math.abs(pv.VOO - 20000 * 24 / 38) <= 1 && Math.abs(pv.VXUS - 20000 * 14 / 38) <= 1);
plan = contributionPlan([{ symbol: 'VOO', value: 70000 }, { symbol: 'VXUS', value: 30000 }], [{ symbol: 'VOO', pct: 70 }, { symbol: 'VXUS', pct: 30 }], 10000);
assert.deepEqual(plan, [{ symbol: 'VOO', amount: 7000 }, { symbol: 'VXUS', amount: 3000 }], 'ya equilibrado: según los porcentajes');
plan = contributionPlan([], [{ symbol: 'VOO', pct: 100 }], 12345);
assert.deepEqual(plan, [{ symbol: 'VOO', amount: 12345 }], 'portafolio vacío');
plan = contributionPlan(rows, [{ symbol: 'VOO', pct: 70 }, { symbol: 'VXUS', pct: 20 }], 1);
assert.equal(plan.reduce((a, p) => a + p.amount, 0), 1, 'sin perder centavos al redondear');
ok('próximo aporte: compra lo que más falta sin vender, y sin perder centavos');

// --- historial de precios (time_series) ---
let r = parseSeries({ meta: { symbol: 'VOO' }, values: [{ datetime: '2026-01-05', close: '510.00' }, { datetime: '2026-01-02', close: '500.5' }], status: 'ok' }, ['VOO']);
assert.deepEqual(r.series.VOO, [['2026-01-02', 50050], ['2026-01-05', 51000]]);
r = parseSeries({ VOO: { values: [{ datetime: '2026-01-02', close: '1' }], status: 'ok' }, ZZZ: { code: 404, message: 'símbolo no encontrado', status: 'error' } }, ['VOO', 'ZZZ']);
assert.ok(r.series.VOO && r.errors.ZZZ);
assert.match(parseSeries({ code: 429, message: 'x', status: 'error' }, ['VOO', 'QQQ']).fatal, /límite/);
assert.equal(parseSeries({ code: 404, message: 'no existe', status: 'error' }, ['ZZZZ']).errors.ZZZZ, 'no existe');
assert.match(parseSeries({ code: 401, message: 'x', status: 'error' }, ['VOO']).fatal, /clave/);
let seen = '';
r = await fetchSeries(['VOO', 'QQQ'], '2026-01-01', 'k', async (u) => { seen = u; return { status: 200, json: async () => ({ VOO: { values: [], status: 'ok' }, QQQ: { values: [{ datetime: '2026-01-02', close: '400' }], status: 'ok' } }) }; });
assert.match(seen, /time_series\?symbol=VOO%2CQQQ&interval=1day&start_date=2026-01-01&outputsize=5000&apikey=k$/);
assert.equal(r.errors.VOO, 'Sin datos');
assert.ok(r.series.QQQ);
r = await fetchSeries(['VOO'], '2026-01-01', 'k', async () => { throw new TypeError('x'); });
assert.ok(r.network && r.fatal);
ok('historial de precios: un día por fila, ordenado; errores por símbolo y de red');

console.log(`\nTodas las pruebas de portafolio pasaron (${n}).`);
