// Comparar con un índice y asignación objetivo (puro, sin navegador). Solo posiciones en USD.
import { roundQty, sortOps } from './invest.js';

// Índices que se siguen a través de un ETF (el plan gratis de precios trae ETF, no índices).
export const BENCHMARKS = [
  { symbol: 'VOO', name: 'S&P 500', hint: 'las 500 empresas grandes de EE. UU.' },
  { symbol: 'QQQ', name: 'Nasdaq-100', hint: 'las 100 mayores del Nasdaq, sobre todo tecnología' },
  { symbol: 'DIA', name: 'Dow Jones', hint: '30 empresas grandes de EE. UU.' },
  { symbol: 'VTI', name: 'Mercado total EE. UU.', hint: 'casi todas las acciones de EE. UU.' },
  { symbol: 'VXUS', name: 'Fuera de EE. UU.', hint: 'acciones del resto del mundo' },
  { symbol: 'IWM', name: 'Russell 2000', hint: 'empresas pequeñas de EE. UU.' },
];
export const benchName = (sym) => (BENCHMARKS.find((b) => b.symbol === sym) || { name: sym }).name;

// series: [[fecha, cierre en centavos], ...] ordenada por fecha. Último cierre en o antes de `date`.
export function closeOn(series, date) {
  if (!series || !series.length || series[0][0] > date) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid][0] <= date) lo = mid; else hi = mid - 1;
  }
  return series[lo][1];
}

const usdOps = (ops) => sortOps(ops.filter((o) => o.currency === 'USD'));

// Tu portafolio: lo que pusiste, lo que sacaste (ventas + dividendos) y lo que vale hoy.
export function actualResult(ops, valueNow) {
  let inv = 0;
  let out = 0;
  for (const o of usdOps(ops)) {
    if (o.kind === 'compra') inv += o.amount;
    else out += o.amount;
  }
  const gain = valueNow + out - inv;
  return { invested: inv, withdrawn: out, value: valueNow, gain, pct: inv > 0 ? gain / inv : null };
}

// "¿Y si cada compra la hubiera hecho en el índice?": cada compra compra el ETF ese día por el mismo
// monto; cada venta vende el mismo monto. Los dividendos no se replican (el ETF los paga aparte).
// Devuelve null si falta el precio de algún día.
export function benchmarkResult(ops, series, today) {
  let shares = 0;
  let inv = 0;
  let out = 0;
  for (const o of usdOps(ops)) {
    if (o.kind === 'dividendo') continue;
    const px = closeOn(series, o.date);
    if (!px) return null;
    if (o.kind === 'compra') { shares += o.amount / px; inv += o.amount; }
    else { const q = Math.min(shares, o.amount / px); shares -= q; out += Math.round(q * px); }
  }
  const pxNow = closeOn(series, today);
  if (!pxNow) return null;
  const value = Math.round(shares * pxNow);
  const gain = value + out - inv;
  return { invested: inv, withdrawn: out, value, gain, pct: inv > 0 ? gain / inv : null };
}

// Fechas para la gráfica: una por semana desde la primera compra, más hoy (máx. ~120 puntos).
export function sampleDates(from, today) {
  const out = [];
  const t0 = Date.parse(from + 'T00:00:00Z');
  const t1 = Date.parse(today + 'T00:00:00Z');
  const days = Math.max(1, Math.round((t1 - t0) / 864e5));
  const step = Math.max(7, Math.ceil(days / 120 / 7) * 7);
  for (let t = t0; t < t1; t += step * 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  out.push(today);
  return out;
}

// Valor en el tiempo: tu portafolio (cantidades de cada fecha × su cierre) y cada índice simulado.
// histories: { SÍMBOLO: series }. Un punto sin precio para algún símbolo queda en null.
export function historyLines(ops, histories, benchSymbols, dates) {
  const list = usdOps(ops);
  const mine = dates.map((date) => {
    const qty = {};
    for (const o of list) {
      if (o.date > date || o.kind === 'dividendo') continue;
      qty[o.symbol] = roundQty((qty[o.symbol] || 0) + (o.kind === 'compra' ? o.qty : -o.qty));
    }
    let v = 0;
    for (const [sym, q] of Object.entries(qty)) {
      if (q <= 0) continue;
      const px = closeOn(histories[sym], date);
      if (!px) return { date, value: null };
      v += q * px;
    }
    return { date, value: Math.round(v) };
  });
  const bench = {};
  for (const b of benchSymbols) {
    const s = histories[b];
    bench[b] = dates.map((date) => {
      const r = benchmarkResult(list.filter((o) => o.date <= date), s, date);
      return { date, value: r ? r.value : null };
    });
  }
  return { mine, bench };
}

// ---------- Asignación objetivo ----------
// rows: posiciones abiertas en USD [{ symbol, value }]. targets: [{ symbol, pct }] (pct en %, suman ≤ 100).
// Lo que no tiene objetivo va a "Otras" con el % que sobra.
export const OTHER = '__otras__';
export function allocation(rows, targets) {
  const total = rows.reduce((a, r) => a + r.value, 0);
  const tmap = new Map(targets.filter((t) => t.pct > 0).map((t) => [t.symbol, t.pct]));
  const rest = Math.max(0, 100 - [...tmap.values()].reduce((a, b) => a + b, 0));
  const buckets = new Map();
  for (const [sym, pct] of tmap) buckets.set(sym, { symbol: sym, value: 0, target: pct });
  for (const r of rows) {
    const key = tmap.has(r.symbol) ? r.symbol : OTHER;
    if (!buckets.has(key)) buckets.set(key, { symbol: key, value: 0, target: rest, members: [] });
    const b = buckets.get(key);
    b.value += r.value;
    if (b.members) b.members.push(r.symbol);
  }
  if (rest > 0 && !buckets.has(OTHER)) buckets.set(OTHER, { symbol: OTHER, value: 0, target: rest, members: [] });
  const list = [...buckets.values()].map((b) => {
    const actual = total > 0 ? (b.value / total) * 100 : 0;
    return { ...b, actual, diff: actual - b.target, gapValue: Math.round((b.target / 100) * total - b.value) };
  });
  list.sort((a, b) => (a.symbol === OTHER) - (b.symbol === OTHER) || b.target - a.target || a.symbol.localeCompare(b.symbol));
  return { total, rest, list };
}

// Cómo repartir un aporte nuevo SIN vender: primero a lo que más falta para llegar al objetivo
// (con el aporte incluido); si sobra, según los porcentajes objetivo. "Otras" no recibe compras.
export function contributionPlan(rows, targets, amount) {
  const { total, list } = allocation(rows, targets);
  const buyable = list.filter((b) => b.symbol !== OTHER && b.target > 0);
  const after = total + amount;
  const need = buyable.map((b) => ({ symbol: b.symbol, need: Math.max(0, (b.target / 100) * after - b.value), target: b.target }));
  const sumNeed = need.reduce((a, x) => a + x.need, 0);
  let plan;
  if (sumNeed >= amount && sumNeed > 0) {
    plan = need.map((x) => ({ symbol: x.symbol, amount: (amount * x.need) / sumNeed }));
  } else {
    const left = amount - sumNeed;
    const tsum = buyable.reduce((a, b) => a + b.target, 0) || 1;
    plan = need.map((x) => ({ symbol: x.symbol, amount: x.need + (left * x.target) / tsum }));
  }
  // Redondeo a centavos sin perder ni sumar plata.
  const out = plan.map((p) => ({ symbol: p.symbol, amount: Math.floor(p.amount) }));
  let diff = amount - out.reduce((a, p) => a + p.amount, 0);
  for (const p of [...out].sort((a, b) => b.amount - a.amount)) { if (diff <= 0) break; p.amount += 1; diff -= 1; }
  return out.filter((p) => p.amount > 0).sort((a, b) => b.amount - a.amount);
}
