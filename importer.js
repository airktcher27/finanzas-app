// Importar extractos (puro, sin navegador): leer CSV, adivinar columnas, interpretar fechas y montos,
// detectar duplicados y categorizar con reglas aprendidas.
import { parseAmount, dec } from './money.js';

export const fold = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ---------- Texto ----------
// Extractos colombianos a veces vienen en Windows-1252 (tildes rotas en UTF-8).
export function decodeBytes(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// CSV con comillas, separador , ; tabulador o |, y saltos \r\n.
export function parseCSV(text) {
  const t = String(text).replace(/^﻿/, '');
  const sample = t.split(/\r?\n/).slice(0, 20).join('\n');
  const count = (ch) => {
    let n = 0;
    let q = false;
    for (const c of sample) { if (c === '"') q = !q; else if (!q && c === ch) n++; }
    return n;
  };
  const sep = [';', ',', '\t', '|'].map((c) => [c, count(c)]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => String(x).trim())).filter((r) => r.some((x) => x !== ''));
}

// ---------- Columnas ----------
const KW = {
  date: ['fecha', 'date', 'dia'],
  desc: ['descripcion', 'detalle', 'concepto', 'comercio', 'establecimiento', 'movimiento', 'transaccion', 'description', 'referencia', 'nombre'],
  amount: ['valor', 'monto', 'importe', 'amount', 'total', 'cantidad'],
  debit: ['debito', 'cargo', 'salida', 'retiro', 'egreso', 'debit'],
  credit: ['credito', 'abono', 'entrada', 'deposito', 'ingreso', 'credit'],
};
const has = (cell, words) => words.some((w) => fold(cell).includes(w));

export function findHeaderRow(rows) {
  const n = Math.min(rows.length, 20);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const hits = ['date', 'desc', 'amount', 'debit', 'credit'].filter((k) => r.some((c) => has(c, KW[k]))).length;
    if (hits >= 2) return i;
  }
  return 0;
}

export function guessMapping(rows, headerRow = findHeaderRow(rows)) {
  const head = rows[headerRow] || [];
  const find = (k, skip = []) => head.findIndex((c, i) => !skip.includes(i) && has(c, KW[k]));
  const date = find('date');
  const debit = find('debit', [date]);
  const credit = find('credit', [date, debit]);
  let amount = find('amount', [date, debit, credit]);
  const desc = find('desc', [date, debit, credit, amount]);
  const body = rows.slice(headerRow + 1, headerRow + 40);
  const mode = debit >= 0 && credit >= 0 ? 'split' : 'single';
  if (mode === 'single' && amount < 0) amount = debit >= 0 ? debit : credit;
  // Signo: si predominan los negativos, los gastos son los negativos (cuentas de ahorro/billeteras);
  // si predominan los positivos (extracto de tarjeta: compras positivas, pagos negativos), al revés.
  let neg = 0;
  let pos = 0;
  if (mode === 'single' && amount >= 0) {
    for (const r of body) {
      const v = signedAmount(r[amount], 'COP');
      if (v === null || v === 0) continue;
      if (v < 0) neg++; else pos++;
    }
  }
  return {
    headerRow, date, desc, mode, amount, debit, credit,
    sign: neg >= pos ? 'neg' : 'pos',
    dateOrder: guessDateOrder(body.map((r) => r[date])),
  };
}

// ---------- Fechas ----------
const MONTHS = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, jan: 1, apr: 4, aug: 8, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const valid = (y, m, d) => y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate();

export function guessDateOrder(samples) {
  for (const s of samples) {
    const m = String(s ?? '').match(/^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (m && Number(m[1]) > 12) return 'dmy';
    if (m && Number(m[2]) > 12) return 'mdy';
  }
  return 'dmy'; // lo normal en Colombia
}

export function parseDate(v, order = 'dmy') {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) { // número de serie de Excel
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = fold(v);
  let m = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (m) { const [y, mo, d] = [m[1], m[2], m[3]].map(Number); return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null; }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    let [a, b, y] = [m[1], m[2], m[3]].map(Number);
    if (y < 100) y += 2000;
    const [d, mo] = order === 'mdy' ? [b, a] : [a, b];
    return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = s.match(/^(\d{1,2})(?:\s+de)?[\s/.-]+([a-z]{3})[a-z]*\.?(?:\s+de)?[\s/.-]+(\d{2,4})/);
  if (m && MONTHS[m[2]]) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const d = Number(m[1]);
    return valid(y, MONTHS[m[2]], d) ? `${y}-${pad(MONTHS[m[2]])}-${pad(d)}` : null;
  }
  return null;
}

// ---------- Montos ----------
// "-12.500", "$ -12.500,00", "(12.500)", "12.500-", "1,234.56", número de Excel.
export function signedAmount(v, cur) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 10 ** dec(cur)) : null;
  const s = String(v).trim().replace(/[\u2212\u2013]/g, '-');
  const neg = /^\(.*\)$/.test(s) || /^-|^\$\s*-|-\s*$|^-\s*\$/.test(s.replace(/\s+/g, ' '));
  const abs = parseAmount(s.replace(/[()\-+]/g, ''), cur);
  if (abs === null) return null;
  return neg ? -abs : abs;
}

// ---------- Filas ----------
const TRANSFER_RE = /\b(pago|abono a|transferen|traslado|recarga desde|envio a|envio de)\b/;

export function buildRows(rows, map, cur) {
  const out = [];
  for (let i = map.headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = parseDate(r[map.date], map.dateOrder);
    if (!date) continue;
    let amount;
    let kind;
    if (map.mode === 'split') {
      const dv = signedAmount(r[map.debit], cur);
      const cv = signedAmount(r[map.credit], cur);
      if (dv) { amount = Math.abs(dv); kind = 'gasto'; }
      else if (cv) { amount = Math.abs(cv); kind = 'ingreso'; }
      else continue;
    } else {
      const v = signedAmount(r[map.amount], cur);
      if (!v) continue;
      amount = Math.abs(v);
      kind = (v < 0) === (map.sign === 'neg') ? 'gasto' : 'ingreso';
    }
    const desc = map.desc >= 0 ? String(r[map.desc] ?? '').replace(/\s+/g, ' ').trim() : '';
    out.push({ line: i + 1, date, desc, amount, kind, maybeTransfer: TRANSFER_RE.test(fold(desc)) });
  }
  return out;
}

// ---------- Reglas y duplicados ----------
// Clave del comercio: sin números ni símbolos, primeras 3 palabras ("UBER *TRIP 4521" → "uber trip").
export function merchantKey(desc) {
  return fold(desc).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1).slice(0, 3).join(' ');
}

export function ruleFor(desc, rules) {
  const f = fold(desc);
  let best = null;
  for (const r of rules) if (r.pattern && f.includes(r.pattern) && (!best || r.pattern.length > best.pattern.length)) best = r;
  return best;
}

// Marca como duplicada cada fila que ya existe en la cuenta: mismo tipo y monto, fecha a ±2 días.
// Cada movimiento existente sirve para una sola fila.
export function markDuplicates(rows, existing, accountId) {
  const pool = existing.filter((m) => !m.deleted && !m.virtual && (m.accountId === accountId || m.toAccountId === accountId));
  const used = new Set();
  const day = (s) => Date.parse(s + 'T00:00:00Z') / 864e5;
  return rows.map((r) => {
    const hit = pool.find((m) => !used.has(m.id) && Math.abs(day(m.date) - day(r.date)) <= 2 && (
      (m.accountId === accountId && m.amount === r.amount && m.kind === r.kind) ||
      (m.kind === 'transferencia' && m.toAccountId === accountId && (m.toAmount ?? m.amount) === r.amount && r.kind === 'ingreso') ||
      (m.kind === 'transferencia' && m.accountId === accountId && m.amount === r.amount && r.kind === 'gasto')));
    if (hit) used.add(hit.id);
    return { ...r, duplicate: !!hit };
  });
}
