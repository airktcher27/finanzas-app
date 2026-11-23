import assert from 'node:assert/strict';
import { normSymbol, parseQty, computePositions, firstOversold, holdingsCostAt, valuePositions, invFlows } from './invest.js';
import { parsePrices, fetchPrices, MAX_PER_CALL } from './prices.js';
import { netSummary, netWorthAt, netWorthPoints, accountBalances } from './ledger.js';

let n = 0;
const ok = (s) => console.log(`  ok ${++n}. ${s}`);
let id = 0;
const op = (o) => ({ id: 'o' + ++id, createdAt: id, currency: 'USD', accountId: '', ...o });

// --- símbolos y cantidades ---
assert.equal(normSymbol(' voo '), 'VOO');
assert.equal(normSymbol('brk.b'), 'BRK.B');
assert.equal(normSymbol('<b>x'), 'BX');
assert.equal(parseQty('0.0153'), 0.0153);
assert.equal(parseQty('0,0153'), 0.0153);
assert.equal(parseQty('12'), 12);
assert.equal(parseQty('1,234.5'), 1234.5);
assert.equal(parseQty('abc'), null);
assert.equal(parseQty('0.123456789'), 0.12345679);
ok('símbolos y cantidades (coma o punto decimal, 8 decimales)');

// --- costo promedio ---
let ops = [
  op({ symbol: 'VOO', kind: 'compra', date: '2026-01-10', qty: 2, amount: 100000 }),   // US$1000 por 2
  op({ symbol: 'VOO', kind: 'compra', date: '2026-02-10', qty: 2, amount: 120000 }),   // US$1200 por 2
];
let p = computePositions(ops).get('VOO');
assert.equal(p.qty, 4);
assert.equal(p.cost, 220000);
ok('dos compras suman cantidad y costo');

ops.push(op({ symbol: 'VOO', kind: 'venta', date: '2026-03-01', qty: 1, amount: 70000 })); // vende 1 a US$700
p = computePositions(ops).get('VOO');
assert.equal(p.qty, 3);
assert.equal(p.cost, 165000);      // costo promedio 55000 por acción → quedan 3 × 55000
assert.equal(p.realized, 70000 - 55000);
ok('venta parcial: sale costo proporcional y se calcula ganancia realizada');

ops.push(op({ symbol: 'VOO', kind: 'venta', date: '2026-03-02', qty: 3, amount: 180000 }));
p = computePositions(ops).get('VOO');
assert.equal(p.qty, 0);
assert.equal(p.cost, 0);
assert.equal(p.realized, 15000 + (180000 - 165000));
ok('venta total deja cero y todo el costo restante se realiza');

// --- fracciones ---
const frac = [
  op({ symbol: 'NVDA', kind: 'compra', date: '2026-01-01', qty: 0.0153, amount: 300 }),
  op({ symbol: 'NVDA', kind: 'compra', date: '2026-01-02', qty: 0.0247, amount: 500 }),
];
p = computePositions(frac).get('NVDA');
assert.equal(p.qty, 0.04);
assert.equal(p.cost, 800);
const fv = valuePositions(computePositions(frac), new Map([['NVDA', { price: 25000 }]]));
assert.equal(fv.rows[0].value, 1000);
assert.equal(fv.totals.USD.unrealized, 200);
ok('fracciones de acción sin errores de decimales');

// --- ventas sin respaldo ---
const bad = [
  op({ symbol: 'META', kind: 'compra', date: '2026-01-01', qty: 1, amount: 50000 }),
  op({ symbol: 'META', kind: 'venta', date: '2026-02-01', qty: 2, amount: 120000 }),
];
assert.equal(firstOversold(bad), 'META');
assert.equal(firstOversold(ops), null);
const early = [op({ symbol: 'NU', kind: 'venta', date: '2026-01-01', qty: 1, amount: 1000 }),
  op({ symbol: 'NU', kind: 'compra', date: '2026-02-01', qty: 1, amount: 900 })];
assert.equal(firstOversold(early), 'NU');
ok('detecta ventas que superan lo que tenías en esa fecha');

// --- dividendos ---
const dv = [...frac, op({ symbol: 'NVDA', kind: 'dividendo', date: '2026-02-01', amount: 7 })];
p = computePositions(dv).get('NVDA');
assert.equal(p.dividends, 7);
assert.equal(p.qty, 0.04);
assert.equal(p.cost, 800);
ok('dividendos no cambian cantidad ni costo');

// --- valoración con y sin precio ---
const two = [
  op({ symbol: 'VOO', kind: 'compra', date: '2026-01-01', qty: 1, amount: 50000 }),
  op({ symbol: 'NU', kind: 'compra', date: '2026-01-01', qty: 10, amount: 15000 }),
];
const v = valuePositions(computePositions(two), new Map([['VOO', { price: 60000 }]]));
assert.equal(v.totals.USD.value, 60000 + 15000);
assert.equal(v.totals.USD.cost, 65000);
assert.equal(v.totals.USD.unrealized, 10000);
assert.equal(v.totals.USD.missing, 1);
const rv = v.rows.find((r) => r.symbol === 'VOO');
assert.equal(rv.hasPrice, true);
assert.ok(Math.abs(rv.pct - 0.2) < 1e-9);
assert.equal(v.rows.find((r) => r.symbol === 'NU').hasPrice, false);
ok('sin precio se valora a costo y se avisa; con precio calcula ganancia y %');

// --- flujos a cuentas ---
const fl = invFlows([
  op({ symbol: 'VOO', kind: 'compra', date: '2026-01-01', qty: 1, amount: 50000, accountId: 'hapi' }),
  op({ symbol: 'VOO', kind: 'venta', date: '2026-02-01', qty: 1, amount: 60000, accountId: 'hapi' }),
  op({ symbol: 'VOO', kind: 'dividendo', date: '2026-03-01', amount: 300, accountId: 'hapi' }),
  op({ symbol: 'NU', kind: 'compra', date: '2026-03-01', qty: 1, amount: 1000 }),
]);
assert.equal(fl.length, 3);
assert.deepEqual(fl.map((f) => f.effect), [-50000, 60000, 300]);
const bal = accountBalances([{ id: 'hapi', openingBalance: 100000 }], [], fl);
assert.equal(bal.get('hapi'), 100000 - 50000 + 60000 + 300);
ok('compras restan, ventas y dividendos suman en la cuenta elegida; sin cuenta no mueve nada');

// --- patrimonio ---
assert.deepEqual(holdingsCostAt(two, '2025-12-31'), {});
assert.deepEqual(holdingsCostAt(two, '2026-01-01'), { USD: 65000 });
const acc = [{ id: 'hapi', currency: 'USD', openingBalance: 100000, createdAt: new Date('2026-01-01T12:00:00').getTime() }];
const buy = [op({ symbol: 'VOO', kind: 'compra', date: '2026-01-05', qty: 1, amount: 50000, accountId: 'hapi' })];
const nw = netWorthAt(acc, [], invFlows(buy), [], [], '2026-01-31', buy);
assert.equal(nw.USD, 100000);   // comprar con la cuenta no cambia el patrimonio: -50000 caja + 50000 costo
const pts = netWorthPoints(acc, [], invFlows(buy), [], [], 'USD', '2026-02-10', 6, buy);
assert.ok(pts.every((q) => q.value === 100000));
const ns = netSummary(acc, new Map([['hapi', 50000]]), {}, { USD: { value: 62000 } });
assert.equal(ns.USD.inv, 62000);
assert.equal(ns.USD.net, 112000);
assert.equal(netSummary(acc, new Map([['hapi', 50000]])).USD.inv, undefined);
ok('patrimonio: comprar con una cuenta no lo cambia; el valor de mercado se suma al neto');

// --- precios: interpretación de respuestas ---
let r = parsePrices({ price: '200.99001' }, ['VOO']);
assert.equal(r.prices.VOO, 20099.001);
r = parsePrices({ VOO: { price: '200.99' }, VXUS: { price: '70.5' } }, ['VOO', 'VXUS']);
assert.deepEqual(r.prices, { VOO: 20099, VXUS: 7050 });
r = parsePrices({ code: 401, message: 'bad key', status: 'error' }, ['VOO']);
assert.match(r.fatal, /clave/);
r = parsePrices({ code: 429, message: 'limit', status: 'error' }, ['VOO', 'NU']);
assert.match(r.fatal, /límite/);
r = parsePrices({ VOO: { price: '1' }, ZZZ: { code: 404, message: 'not found', status: 'error' } }, ['VOO', 'ZZZ']);
assert.equal(r.prices.VOO, 100);
assert.equal(r.errors.ZZZ, 'not found');
r = parsePrices({ VOO: { price: '0' } }, ['VOO']);
assert.ok(r.errors.VOO);
assert.ok(parsePrices(null, ['VOO']).fatal);
ok('interpreta precio único, lote, errores de clave/límite y símbolo desconocido');

// --- precios: consulta ---
let seen = null;
const fakeOk = async (url) => { seen = url; return { status: 200, json: async () => ({ VOO: { price: '200' }, NU: { price: '15.5' } }) }; };
r = await fetchPrices(['VOO', 'NU', 'VOO'], 'K 1', fakeOk);
assert.deepEqual(r.prices, { VOO: 20000, NU: 1550 });
assert.match(seen, /symbol=VOO%2CNU&apikey=K%201$/);
const many = Array.from({ length: MAX_PER_CALL + 2 }, (_, i) => 'S' + i);
r = await fetchPrices(many, 'k', async () => ({ status: 200, json: async () => ({}) }));
assert.equal(r.skipped.length, 2);
r = await fetchPrices(['VOO'], 'k', async () => { throw new TypeError('Failed to fetch'); });
assert.ok(r.network && /a mano/.test(r.fatal));
r = await fetchPrices(['VOO'], 'k', async () => ({ status: 502, json: async () => { throw new Error('x'); } }));
assert.match(r.fatal, /502/);
assert.deepEqual((await fetchPrices([], 'k', fakeOk)).prices, {});
ok('consulta: arma la URL, limita a 8, y maneja red caída o respuesta rota');

console.log(`\nTodas las pruebas de inversiones pasaron (${n}).`);
