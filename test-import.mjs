import assert from 'node:assert/strict';
import { parseCSV, decodeBytes, findHeaderRow, guessMapping, parseDate, signedAmount, buildRows, merchantKey, ruleFor, markDuplicates, guessDateOrder } from './importer.js';

let n = 0;
const ok = (s) => console.log(`  ok ${++n}. ${s}`);

// --- CSV ---
let rows = parseCSV('﻿Fecha;Descripción;Valor\r\n01/11/2026;"UBER; TRIP";-12.500\r\n02/11/2026;"Dice ""hola""";1.000.000\r\n\r\n');
assert.deepEqual(rows, [['Fecha', 'Descripción', 'Valor'], ['01/11/2026', 'UBER; TRIP', '-12.500'], ['02/11/2026', 'Dice "hola"', '1.000.000']]);
assert.deepEqual(parseCSV('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
assert.deepEqual(parseCSV('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
ok('CSV: separador ; , o tabulador, comillas dobles, BOM y líneas vacías');

const latin1 = new Uint8Array([0x44, 0xe9, 0x62, 0x69, 0x74, 0x6f]); // "Débito" en Windows-1252
assert.equal(decodeBytes(latin1), 'Débito');
assert.equal(decodeBytes(new TextEncoder().encode('Crédito')), 'Crédito');
ok('texto en UTF-8 o Windows-1252');

// --- fechas ---
assert.equal(parseDate('01/11/2026'), '2026-11-01');
assert.equal(parseDate('11/01/2026', 'mdy'), '2026-11-01');
assert.equal(parseDate('2026-11-01 08:30'), '2026-11-01');
assert.equal(parseDate('1-nov-26'), '2026-11-01');
assert.equal(parseDate('01 Nov. 2026'), '2026-11-01');
assert.equal(parseDate('3 de diciembre de 2026'), '2026-12-03');
assert.equal(parseDate(46327), '2026-11-01'); // serie de Excel
assert.equal(parseDate('31/02/2026'), null);
assert.equal(parseDate('Saldo anterior'), null);
assert.equal(guessDateOrder(['01/11/2026', '25/11/2026']), 'dmy');
assert.equal(guessDateOrder(['11/25/2026']), 'mdy');
ok('fechas: dd/mm/aaaa, aaaa-mm-dd, "1-nov-26", "3 de diciembre de 2026" y número de Excel');

// --- montos ---
assert.equal(signedAmount('-12.500', 'COP'), -12500);
assert.equal(signedAmount('$ -12.500,00', 'COP'), -12500);
assert.equal(signedAmount('(12.500)', 'COP'), -12500);
assert.equal(signedAmount('12.500-', 'COP'), -12500);
assert.equal(signedAmount('−9.000', 'COP'), -9000);
assert.equal(signedAmount('1,234.56', 'USD'), 123456);
assert.equal(signedAmount(-25.5, 'USD'), -2550);
assert.equal(signedAmount('', 'COP'), null);
ok('montos: negativos con -, paréntesis o signo al final; miles con punto o coma');

// --- columnas y filas: extracto tipo billetera (gastos negativos) ---
const wallet = parseCSV([
  'Extracto de movimientos',
  'Cuenta: 300****123',
  'Fecha,Descripción,Valor,Saldo',
  '01/11/2026,Compra en D1 Calle 45,-45.300,954.700',
  '02/11/2026,Recibiste de JUAN PEREZ,100.000,1.054.700',
  '03/11/2026,Pago tarjeta Nu,-200.000,854.700',
  'Total,,,',
].join('\n'));
assert.equal(findHeaderRow(wallet), 2);
let map = guessMapping(wallet);
assert.deepEqual([map.date, map.desc, map.amount, map.mode, map.sign, map.dateOrder], [0, 1, 2, 'single', 'neg', 'dmy']);
let built = buildRows(wallet, map, 'COP');
assert.deepEqual(built.map((r) => [r.date, r.kind, r.amount]), [['2026-11-01', 'gasto', 45300], ['2026-11-02', 'ingreso', 100000], ['2026-11-03', 'gasto', 200000]]);
assert.deepEqual(built.map((r) => r.maybeTransfer), [false, false, true]);
ok('billetera: encuentra el encabezado bajo el título, gastos negativos, y marca pagos como posible transferencia');

// --- extracto de tarjeta (compras positivas) con débito/crédito en columnas ---
const card = parseCSV('Fecha transacción;Establecimiento;Cargos;Abonos\n05/11/2026;NETFLIX.COM;38.900;\n10/11/2026;PAGO PSE;;500.000');
map = guessMapping(card);
assert.equal(map.mode, 'split');
built = buildRows(card, map, 'COP');
assert.deepEqual(built.map((r) => [r.kind, r.amount, r.desc]), [['gasto', 38900, 'NETFLIX.COM'], ['ingreso', 500000, 'PAGO PSE']]);
const cardSingle = parseCSV('Fecha,Descripcion,Monto\n05/11/2026,NETFLIX,38900\n06/11/2026,RAPPI,25000\n10/11/2026,PAGO,-500000');
map = guessMapping(cardSingle);
assert.equal(map.sign, 'pos');
assert.deepEqual(buildRows(cardSingle, map, 'COP').map((r) => r.kind), ['gasto', 'gasto', 'ingreso']);
ok('tarjeta: columnas de cargos y abonos, o una sola columna con compras positivas');

// --- reglas ---
assert.equal(merchantKey('UBER *TRIP 4521 BOGOTA'), 'uber trip bogota');
assert.equal(merchantKey('Compra en D1 Calle 45'), 'compra en calle');
const rules = [{ pattern: 'uber', categoryId: 'transporte' }, { pattern: 'uber eats', categoryId: 'comida' }];
assert.equal(ruleFor('UBER EATS pedido', rules).categoryId, 'comida', 'gana la regla más específica');
assert.equal(ruleFor('Uber trip', rules).categoryId, 'transporte');
assert.equal(ruleFor('Éxito', rules), null);
ok('reglas de categoría: por comercio, gana la más específica');

// --- duplicados ---
const existing = [
  { id: 'a', kind: 'gasto', accountId: 'nq', amount: 45300, date: '2026-10-31' },
  { id: 'b', kind: 'transferencia', accountId: 'nq', toAccountId: 'nu', amount: 200000, date: '2026-11-03' },
  { id: 'c', kind: 'gasto', accountId: 'otra', amount: 100000, date: '2026-11-02' },
  { id: 'd', kind: 'gasto', accountId: 'nq', amount: 45300, date: '2026-11-01', deleted: true },
];
const marked = markDuplicates([
  { date: '2026-11-01', kind: 'gasto', amount: 45300 },
  { date: '2026-11-01', kind: 'gasto', amount: 45300 },
  { date: '2026-11-02', kind: 'ingreso', amount: 100000 },
  { date: '2026-11-03', kind: 'gasto', amount: 200000 },
], existing, 'nq');
assert.deepEqual(marked.map((r) => r.duplicate), [true, false, false, true]);
ok('duplicados: mismo monto y tipo a ±2 días (también transferencias), cada uno una sola vez');

console.log(`\nTodas las pruebas de importación pasaron (${n}).`);
