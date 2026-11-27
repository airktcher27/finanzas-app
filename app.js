import { openStore } from './comun/store.js';
import { createGithub } from './comun/github.js';
import { runSync, exportEncrypted, importEncrypted, CAP_GZ } from './comun/sync.js';
import { decryptJson, deriveKey } from './comun/crypto.js';
import { decodeBytes, parseCSV, guessMapping, buildRows, markDuplicates, merchantKey, ruleFor } from './importer.js';
import { trashGroups, purgeable, restorePlan, versionSummary, TRASH_DAYS } from './trash.js';
import { SyncError } from './comun/errors.js';
import { parseAmount, formatMoney, toInput, dec, CURRENCIES, setMoneyHidden, moneyHidden } from './money.js';
import {
  live, accountBalances, filterMovs, monthTotals, netSummary, todayStr, monthOf, shiftMonth,
  debtFlows, debtRemaining, debtIsDone, debtTotals, debtsByPerson, personKey, searchMovs, listTotals, monthEnd, interestMovs, activeInstallments, installmentPlan, hasCuotas, addDays, cardCycle,
  categoryTotals, lastMonths, monthSeries, netWorthPoints, budgetState,
  savingsMonth, savingsYear, goalTargets, yearNeeded,
} from './ledger.js';
import { normSymbol, parseQty, computePositions, firstOversold, valuePositions, invFlows } from './invest.js';
import { fetchPrices, fetchTrm, fetchSeries } from './prices.js';
import { rankedBars, groupedColumns, lineChart, columnsTarget, tableView, hideTip, multiLine } from './charts.js';
import { BENCHMARKS, benchName, actualResult, benchmarkResult, sampleDates, historyLines, allocation, contributionPlan, OTHER } from './portfolio.js';
import { DEFAULT_CATEGORIES, SUGGESTED_ACCOUNTS, ACCOUNT_TYPES } from './defaults.js';

const VERSION = '0.11.3 (Fase 7)';
const PX_KEY = 'finanzas.twelve';
const CFG_KEY = 'finanzas.cfg';
const $ = (s) => document.querySelector(s);

let store;
let deviceId;
let syncing = false;
let syncTimer = null;
const ui = { tab: 'resumen', month: monthOf(todayStr()), filterAccount: '', data: null, rMonth: monthOf(todayStr()), rCur: 'COP', debtPerson: '', q: '', fKind: '', fCat: '', period: 'mes', from: '', to: '', showFilters: false, selecting: false, sel: new Set(), searchFocus: false, pxMsg: '', pxBusy: false, lastPxTry: 0, fxMsg: '', fxBusy: false, lastFxTry: 0 };

// ---------- Ayudantes de DOM ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const opt = (value, label, selected) => h('option', { value, selected: !!selected }, label);

function openSheet(content) {
  const dlg = $('#sheet');
  $('#sheet-body').replaceChildren(content);
  if (!dlg.open) dlg.showModal();
}
function closeSheet() {
  const dlg = $('#sheet');
  if (dlg.open) dlg.close();
}

// ---------- Configuración (solo en este dispositivo) ----------
function loadCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; }
}
function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }
function isConfigured() {
  const c = loadCfg();
  return !!(c.owner && c.repo && c.token);
}

// ---------- Estado ----------
function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + kind;
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'hace unos segundos';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const hh = Math.round(m / 60);
  if (hh < 24) return `hace ${hh} h`;
  return `hace ${Math.round(hh / 24)} d`;
}

async function showIdleStatus() {
  if (!isConfigured()) {
    setStatus('Sin configurar: ve a Ajustes para activar la sincronización.', 'warn');
    return;
  }
  const last = await store.getMeta('lastSync');
  setStatus(last ? `Última sincronización ${timeAgo(last)}.` : 'Aún no has sincronizado.', last ? 'ok' : 'warn');
}

function errorMessage(e) {
  switch (e.code) {
    case 'WRONG_KEY': return 'Contraseña incorrecta.';
    case 'BAD_TOKEN': return 'El token es inválido o venció. Crea uno nuevo en GitHub.';
    case 'REPO_NOT_FOUND':
    case 'FORBIDDEN':
    case 'HTTP':
    case 'CONFLICT':
    case 'BAD_FILE': return e.message;
    default:
      if (e instanceof TypeError) return 'Sin conexión. Los cambios quedan guardados y se sincronizarán después.';
      return 'Error: ' + (e.message || e);
  }
}

// ---------- Diálogo de contraseña ----------
function askPassphrase({ isNew, title, text }) {
  return new Promise((resolve) => {
    const dlg = $('#pass-dialog');
    const p1 = $('#pass-1');
    const p2 = $('#pass-2');
    const err = $('#pass-error');
    $('#pass-title').textContent = title || (isNew ? 'Crea una contraseña de cifrado' : 'Contraseña de cifrado');
    $('#pass-text').textContent =
      text ||
      (isNew
        ? 'Cifra tus datos antes de subirlos. Si la pierdes, no se pueden recuperar. Usa la misma en todos tus dispositivos.'
        : 'Es la contraseña con la que se cifraron los datos.');
    $('#pass-2-wrap').hidden = !isNew;
    p2.required = !!isNew;
    p1.value = '';
    p2.value = '';
    err.hidden = true;

    const form = $('#pass-form');
    const cancel = $('#pass-cancel');
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      cancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
    };
    const onSubmit = (ev) => {
      ev.preventDefault();
      if (isNew && p1.value !== p2.value) {
        err.textContent = 'Las contraseñas no coinciden.';
        err.hidden = false;
        return;
      }
      if (isNew && p1.value.length < 8) {
        err.textContent = 'Usa al menos 8 caracteres.';
        err.hidden = false;
        return;
      }
      const v = p1.value;
      cleanup();
      dlg.close();
      resolve(v);
    };
    const onCancel = (ev) => {
      if (ev) ev.preventDefault();
      cleanup();
      dlg.close();
      resolve(null);
    };
    form.addEventListener('submit', onSubmit);
    cancel.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    p1.focus();
  });
}

// ---------- Datos ----------
async function saveRecords(list) {
  const t = Date.now();
  for (const r of list) {
    r.updatedAt = t;
    r.dev = deviceId;
  }
  await store.putRecords(list);
  await render();
  scheduleSync();
}
const saveRecord = (r) => saveRecords([r]);

// Categorías iniciales con id fijo y updatedAt 0: cualquier edición real las supera
// y dos dispositivos no las duplican.
// Cada dispositivo deja constancia de su versión y de que entiende el formato comprimido.
async function registerDevice() {
  const all = await store.getAllRecords();
  const me = all.find((r) => r.col === 'dispositivos' && r.id === deviceId);
  if (me && me.version === VERSION && Date.now() - (me.seenAt || 0) < 7 * 864e5) return;
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone' : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Otro';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const rec = { col: 'dispositivos', id: deviceId, caps: [CAP_GZ], version: VERSION, name: `${os} · ${br}`, seenAt: Date.now(), deleted: false };
  rec.updatedAt = Date.now();
  rec.dev = deviceId;
  await store.putRecords([rec]);
}

// Quita los datos de lo que lleva más de 30 días en la papelera (o de todo, al vaciarla).
async function purgeTrash(everything) {
  const list = purgeable(await store.getAllRecords(), Date.now(), everything);
  if (!list.length) return;
  if (everything) await saveRecords(list);
  else await store.putRecords(list);
}

async function seedDefaults() {
  if ((await store.getMeta('seededCats')) === 2) return;
  const all = await store.getAllRecords();
  const have = new Set(all.filter((r) => r.col === 'categorias').map((r) => r.id));
  const recs = DEFAULT_CATEGORIES.filter((c) => !have.has(c.id)).map((c, i) => ({
    col: 'categorias', id: c.id, name: c.name, kind: c.kind, archived: false, deleted: false, order: i, updatedAt: 0, dev: '',
  }));
  await store.putRecords(recs);
  await store.setMeta('seededCats', 2);
}

async function loadData() {
  const all = await store.getAllRecords();
  const accounts = live(all, 'cuentas').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const cats = live(all, 'categorias').sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name, 'es'));
  const realMovs = live(all, 'movs');
  const liveAccById = new Map(live(all, 'cuentas').map((a) => [a.id, a]));
  const movs = [...realMovs, ...interestMovs(realMovs, liveAccById, todayStr())];
  const debts = live(all, 'deudas').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const debtIds = new Set(debts.map((x) => x.id));
  const abonos = live(all, 'abonos').filter((a) => debtIds.has(a.debtId));
  const ops = live(all, 'inv');
  const trash = trashGroups(all);
  const allAccounts = new Map(all.filter((r) => r.col === 'cuentas').map((r) => [r.id, r]));
  const compactRec = all.find((r) => r.col === 'config' && r.id === 'compactacion' && !r.deleted) || null;
  const prices = new Map(live(all, 'precios').map((r) => [r.symbol, r]));
  const flows = [...debtFlows(debts, abonos), ...invFlows(ops)];
  const fx = prices.get('USDCOP') || null;
  const infl = live(all, 'config').find((r) => r.id === 'inflacion') || null;
  const inv = valuePositions(computePositions(ops), prices, {
    fxNow: fx ? fx.price : 0, annual: infl && infl.annual !== null && infl.annual !== undefined ? infl.annual : null, today: todayStr(),
  });
  const budgets = live(all, 'presupuestos');
  const benchCfg = live(all, 'config').find((r) => r.id === 'benchmarks') || null;
  const allocCfg = live(all, 'config').find((r) => r.id === 'asignacion') || null;
  const rules = live(all, 'reglas');
  const importProfiles = new Map(live(all, 'config').filter((r) => r.id.startsWith('import-')).map((r) => [r.id.slice(7), r]));
  const goals = live(all, 'metas');
  const cycles = new Map();
  for (const a of accounts) {
    if (a.type !== 'credito' || a.archived) continue;
    const c = cardCycle(a, movs, flows, todayStr());
    if (c) cycles.set(a.id, c);
  }
  return {
    accounts,
    cats,
    movs,
    realMovs,
    installments: activeInstallments(realMovs, liveAccById, todayStr()),
    debts,
    abonos,
    flows,
    ops,
    prices,
    trash,
    allAccounts,
    compactRec,
    fx,
    infl,
    inv,
    budgets,
    benchCfg,
    allocCfg,
    rules,
    importProfiles,
    goals,
    cycles,
    debtTot: debtTotals(debts, abonos),
    balances: accountBalances(accounts, movs, flows),
    accById: new Map(accounts.map((a) => [a.id, a])),
    catById: new Map(cats.map((c) => [c.id, c])),
  };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const monthLabel = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return cap(new Date(y, mo - 1, 1).toLocaleDateString('es-CO', { month: 'long', year: 'numeric' }));
};
const dayLabel = (ds) => {
  const [y, mo, d] = ds.split('-').map(Number);
  return cap(new Date(y, mo - 1, d).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' }));
};

// ---------- Vista (preferencias de este dispositivo) ----------
const VIEW_KEY = 'finanzas.view';
const TOGGLE_TABS = [['movs', 'Movimientos'], ['inv', 'Inversiones'], ['deudas', 'Deudas'], ['reportes', 'Reportes']];
const INV_SECTIONS = [['inv-bench', 'Comparar con un índice'], ['inv-alloc', 'Asignación y rebalanceo']];
const TOGGLE_SECTIONS = [['savings', 'Meta de ahorro'], ['cuotas', 'Compras a cuotas'], ['due', 'Vencimientos']];
function getView() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(VIEW_KEY)); } catch { /* sin almacenamiento */ }
  return { hiddenTabs: [], hiddenSections: [], hiddenCurrencies: [], ...(v || {}) };
}
// Apariencia: tema (auto/claro/oscuro/negro) y paleta del color principal. Contrastes revisados (≥ 4,5:1)
// para texto sobre el botón y para el color sobre el fondo, en claro y en oscuro.
const PALETTES = {
  verde: { name: 'Verde', light: ['#0f766e', '#ffffff'], dark: ['#2dd4bf', '#05211e'] },
  azul: { name: 'Azul', light: ['#1d4ed8', '#ffffff'], dark: ['#60a5fa', '#0b1b33'] },
  morado: { name: 'Morado', light: ['#6d28d9', '#ffffff'], dark: ['#a78bfa', '#1e1036'] },
  frambuesa: { name: 'Frambuesa', light: ['#be185d', '#ffffff'], dark: ['#f472b6', '#3b0a1f'] },
  naranja: { name: 'Naranja', light: ['#c2410c', '#ffffff'], dark: ['#fb923c', '#2a1205'] },
  grafito: { name: 'Grafito', light: ['#334155', '#ffffff'], dark: ['#cbd5e1', '#0f172a'] },
};
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
// 'black' (Negro) es el oscuro con fondo negro puro para pantallas OLED: data-theme="dark" + data-negro.
const isDark = (v) => v.theme === 'dark' || v.theme === 'black' || (v.theme !== 'light' && darkMQ.matches);
function applyTheme() {
  const v = getView();
  const root = document.documentElement;
  if (v.theme === 'light' || v.theme === 'dark') root.dataset.theme = v.theme;
  else if (v.theme === 'black') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  root.toggleAttribute('data-negro', v.theme === 'black');
  const dark = isDark(v);
  const p = PALETTES[v.palette] || PALETTES.verde;
  const [acc, accText] = dark ? p.dark : p.light;
  root.style.setProperty('--accent', acc);
  root.style.setProperty('--accent-text', accText);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = v.theme === 'black' ? '#000000' : dark ? '#101416' : acc;
}
darkMQ.addEventListener('change', () => { applyTheme(); if (ui.tab === 'reportes') render(); });

const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
function setPrivacy(on) {
  setMoneyHidden(on);
  const b = $('#btn-privacy');
  b.innerHTML = on ? EYE_OFF : EYE;
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? 'Mostrar montos' : 'Ocultar montos');
  b.title = on ? 'Mostrar montos' : 'Ocultar montos';
  document.documentElement.classList.toggle('privado', on);
  hideTip();
  return render();
}

function setView(patch) {
  const v = { ...getView(), ...patch };
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch { /* sin almacenamiento */ }
  applyTheme();
  return render();
}
const toggleIn = (list, key, on) => (on ? list.filter((x) => x !== key) : [...new Set([...list, key])]);

function renderViewPrefs() {
  const root = $('#view-prefs');
  if (!root) return;
  const v = getView();
  const box = (label, on, onchange) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => onchange(e.target.checked) }), label);
  const seg = (opts, cur, onpick) => h('div', { class: 'seg', role: 'group', style: `grid-template-columns:repeat(${opts.length},1fr)` },
    opts.map(([k, label]) => h('button', { type: 'button', class: k === cur ? 'on' : '', 'aria-pressed': String(k === cur), text: label, onclick: () => onpick(k) })));
  const pal = v.palette && PALETTES[v.palette] ? v.palette : 'verde';
  const dark = isDark(v);
  root.replaceChildren(...[
    h('div', { class: 'section-title', text: 'Tema' }),
    seg([['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro'], ['black', 'Negro']], v.theme || 'auto', (k) => setView({ theme: k })),
    h('div', { class: 'section-title', text: 'Color' }),
    h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Color principal' }, Object.entries(PALETTES).map(([k, p]) =>
      h('button', { type: 'button', class: 'swatch' + (k === pal ? ' on' : ''), role: 'radio', 'aria-checked': String(k === pal), title: p.name, 'aria-label': p.name,
        style: `--sw:${dark ? p.dark[0] : p.light[0]}`, onclick: () => setView({ palette: k }) }, h('span', { class: 'dot' }), h('span', { class: 'nm', text: p.name })))),
    h('div', { class: 'section-title', text: 'Privacidad' }),
    box('Abrir la app con los montos ocultos', !!v.privacyStart, (on) => setView({ privacyStart: on })),
    h('div', { class: 'section-title', text: 'Pestañas' }),
    TOGGLE_TABS.map(([k, label]) => box(label, !v.hiddenTabs.includes(k), (on) => setView({ hiddenTabs: toggleIn(v.hiddenTabs, k, on) }))),
    h('div', { class: 'section-title', text: 'Resumen' }),
    TOGGLE_SECTIONS.map(([k, label]) => box(label, !v.hiddenSections.includes(k), (on) => setView({ hiddenSections: toggleIn(v.hiddenSections, k, on) }))),
    h('div', { class: 'section-title', text: 'Inversiones' }),
    INV_SECTIONS.map(([k, label]) => box(label, !v.hiddenSections.includes(k), (on) => setView({ hiddenSections: toggleIn(v.hiddenSections, k, on) }))),
    Object.entries(CURRENCIES).map(([k, c]) => box(`Total en ${c.label}`, !v.hiddenCurrencies.includes(k), (on) => setView({ hiddenCurrencies: toggleIn(v.hiddenCurrencies, k, on) }))),
  ].flat());
}

// ---------- Vistas ----------
async function render() {
  ui.data = await loadData();
  const view = getView();
  if (view.hiddenTabs.includes(ui.tab)) ui.tab = 'resumen';
  document.querySelectorAll('.tabs button').forEach((b) => { b.hidden = view.hiddenTabs.includes(b.dataset.tab); });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  for (const t of ['resumen', 'movs', 'inv', 'deudas', 'reportes', 'ajustes']) $(`#tab-${t}`).hidden = ui.tab !== t;
  $('#btn-settings').classList.toggle('active', ui.tab === 'ajustes');
  $('#fab').hidden = ui.tab === 'ajustes';
  $('#fab').setAttribute('aria-label', ui.tab === 'deudas' ? 'Añadir deuda' : ui.tab === 'inv' ? 'Añadir operación' : 'Añadir movimiento');
  hideTip();
  if (ui.tab === 'resumen') renderResumen(ui.data);
  else if (ui.tab === 'movs') renderMovs(ui.data);
  else if (ui.tab === 'inv') renderInv(ui.data);
  else if (ui.tab === 'deudas') renderDeudas(ui.data);
  else if (ui.tab === 'reportes') renderReportes(ui.data);
  else { renderCategories(ui.data); renderRules(ui.data); renderViewPrefs(); renderHistoryBox(); }
}

async function showTab(name) {
  ui.tab = name;
  await render();
  // Al entrar a Inversiones, si hay clave, actualiza precios (máx. una vez cada 10 min).
  if (name === 'inv') {
    if (Date.now() - ui.lastFxTry > 600000) await refreshFx(false);
    if (getPxKey() && Date.now() - ui.lastPxTry > 600000) await refreshPrices(false);
  }
}

function accountRow(a, d) {
  const bal = d.balances.get(a.id) || 0;
  let sub = ACCOUNT_TYPES[a.type] || a.type;
  let amt;
  let cls = '';
  if (a.type === 'credito') {
    if (a.creditLimit) sub += ` · Disponible ${formatMoney(a.creditLimit + bal, a.currency)}`;
    if (bal < 0) { amt = `Debes ${formatMoney(-bal, a.currency)}`; cls = 'neg'; }
    else if (bal > 0) { amt = `A favor ${formatMoney(bal, a.currency)}`; cls = 'pos'; }
    else amt = 'Sin deuda';
  } else {
    amt = formatMoney(bal, a.currency);
    if (bal < 0) cls = 'neg';
  }
  const c = d.cycles.get(a.id);
  const sub2 = c
    ? `Pago ${shortDate(c.due)}: ${c.toPay > 0 ? formatMoney(c.toPay, a.currency) + (c.estimate ? ' (aprox.)' : '') : 'nada por pagar'} · Corte ${shortDate(c.nextCut)}`
    : null;
  return h('button', { type: 'button', class: 'item' + (a.archived ? ' archived' : ''), onclick: () => openAccountForm(a) },
    h('div', { class: 'main' },
      h('div', { class: 'title', text: a.name }),
      h('div', { class: 'sub', text: sub }),
      sub2 && h('div', { class: 'sub', text: sub2 })),
    h('div', { class: 'amt ' + cls, text: amt }));
}

// Pago próximo de una tarjeta: al tocarlo abre una transferencia hacia la tarjeta con el monto puesto.
function cardDueRow(a, c) {
  return h('button', { type: 'button', class: 'item',
    onclick: () => openMovForm(null, { kind: 'transferencia', toAccountId: a.id, amount: toInput(c.toPay, a.currency) }) },
    h('div', { class: 'main' },
      h('div', { class: 'title', text: a.name }),
      h('div', { class: 'sub', text: `Pago de tarjeta · ${c.cutPassed ? 'cortó' : 'corta'} el ${shortDate(c.cut)}${c.estimate ? ' (monto aprox.)' : ''}` })),
    h('div', { class: 'amt neg' }, formatMoney(c.toPay, a.currency), h('small', { text: 'Vence ' + shortDate(c.due) })));
}

// Sección plegable del Resumen; recuerda abierta/cerrada en este dispositivo.
const COLL_KEY = 'finanzas.collapsed';
function loadCollapsed() { try { return JSON.parse(localStorage.getItem(COLL_KEY)) || {}; } catch { return {}; } }
function collapsible(key, title, note) {
  const body = h('div', { class: 'coll-body' });
  const el = h('details', { class: 'coll', 'data-key': key },
    h('summary', {}, h('span', { text: title }), note && h('span', { class: 'coll-note', text: note })), body);
  el.open = !loadCollapsed()[key];
  el.addEventListener('toggle', () => {
    const c = loadCollapsed();
    if (el.open) delete c[key]; else c[key] = true;
    try { localStorage.setItem(COLL_KEY, JSON.stringify(c)); } catch { /* sin almacenamiento */ }
  });
  return { el, body };
}

// Compras a cuotas con algo pendiente, agrupadas por moneda.
function renderInstallments(root, d) {
  const list = d.installments;
  if (!list.length) return;
  const box = collapsible('cuotas', 'Compras a cuotas', String(list.length));
  root.append(box.el);
  const byCur = {};
  for (const it of list) {
    const t = (byCur[it.acc.currency] ||= { left: 0, next: 0 });
    t.left += it.remainingTotal;
    t.next += it.next.cuota;
  }
  box.body.append(h('p', { class: 'hint', style: 'margin:0 0 8px' }, Object.entries(byCur).map(([cur, t]) =>
    `Te faltan ${formatMoney(t.left, cur)} en cuotas; en el próximo extracto llegan ${formatMoney(t.next, cur)}.`).join(' ')));
  box.body.append(h('div', { class: 'list' }, list.map((it) => {
    const cat = d.catById.get(it.mov.categoryId);
    const name = it.mov.note || (cat ? cat.name : 'Compra');
    const cur = it.acc.currency;
    return h('button', { type: 'button', class: 'item', onclick: () => openMovForm(it.mov) },
      h('div', { class: 'main' },
        h('div', { class: 'title', text: name }),
        h('div', { class: 'sub', text: `${it.acc.name} · cuota ${it.billedCount + 1} de ${it.plan.n} el ${shortDate(it.next.cut)}: ${formatMoney(it.next.cuota, cur)}` })),
      h('div', { class: 'amt' }, formatMoney(it.remainingTotal, cur), h('small', { text: 'por pagar' })));
  })));
}

function renderResumen(d) {
  const root = $('#resumen-body');
  root.replaceChildren();
  if (!d.accounts.length) {
    root.append(h('div', { class: 'empty' },
      h('p', { text: 'Aún no tienes cuentas. Puedes crear las sugeridas (Nequi, Nubank, Rappi y Hapi) con saldo en cero y luego ajustar cada una.' }),
      h('button', { class: 'btn primary', type: 'button', onclick: createSuggested, text: 'Crear cuentas sugeridas' }),
      h('button', { class: 'btn', type: 'button', onclick: () => openAccountForm(), text: 'Crear una cuenta propia' })));
    return;
  }
  const net = netSummary(d.accounts, d.balances, d.debtTot, d.inv.totals);
  const totals = monthTotals(d.movs, d.accById, monthOf(todayStr()));
  const cards = h('div', { class: 'cards' });
  const view = getView();
  const hiddenCur = Object.keys(net).filter((c) => view.hiddenCurrencies.includes(c));
  for (const cur of Object.keys(net)) {
    if (view.hiddenCurrencies.includes(cur)) continue;
    const n = net[cur];
    const t = totals[cur] || { ingresos: 0, gastos: 0 };
    cards.append(h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', { class: 'cur', text: `Neto · ${CURRENCIES[cur] ? CURRENCIES[cur].label : cur}` }),
        Object.keys(net).filter((c) => !view.hiddenCurrencies.includes(c)).length > 1 && h('button', { class: 'link-btn', type: 'button', text: 'Ocultar', 'aria-label': `Ocultar el total en ${cur}`,
          onclick: () => setView({ hiddenCurrencies: [...new Set([...view.hiddenCurrencies, cur])] }) })),
      h('div', { class: 'big', text: formatMoney(n.net, cur) }),
      h('div', { class: 'line' }, h('span', { text: 'Disponible' }), h('span', { text: formatMoney(n.assets, cur) })),
      n.cards !== 0 && h('div', { class: 'line' }, h('span', { text: 'Tarjetas' }), h('span', { text: formatMoney(n.cards, cur) })),
      n.inv && h('div', { class: 'line' }, h('span', { text: 'Inversiones' }), h('span', { text: formatMoney(n.inv, cur) })),
      n.toMe !== 0 && h('div', { class: 'line' }, h('span', { text: 'Te deben' }), h('span', { text: formatMoney(n.toMe, cur) })),
      n.iOwe !== 0 && h('div', { class: 'line' }, h('span', { text: 'Debes (préstamos)' }), h('span', { text: formatMoney(-n.iOwe, cur) })),
      h('div', { class: 'line' }, h('span', { text: 'Ingresos este mes' }), h('span', { text: formatMoney(t.ingresos, cur) })),
      h('div', { class: 'line' }, h('span', { text: 'Gastos este mes' }), h('span', { text: formatMoney(t.gastos, cur) }))));
  }
  if (cards.children.length) root.append(cards);
  if (hiddenCur.length) {
    root.append(h('div', { class: 'row wrap', style: 'margin:-4px 0 10px' }, hiddenCur.map((cur) =>
      h('button', { class: 'btn', type: 'button', text: `Mostrar total en ${CURRENCIES[cur] ? CURRENCIES[cur].label : cur}`,
        onclick: () => setView({ hiddenCurrencies: view.hiddenCurrencies.filter((x) => x !== cur) }) }))));
  }

  if (!view.hiddenSections.includes('savings')) renderSavings(root, d);
  if (!view.hiddenSections.includes('cuotas')) renderInstallments(root, d);

  const limit = addDays(todayStr(), 7);
  const soon = [];
  for (const x of d.debts) {
    if (!debtIsDone(x, d.abonos) && x.dueDate && x.dueDate <= limit) soon.push({ date: x.dueDate, el: debtRow(x, d) });
  }
  for (const a of d.accounts) {
    const c = d.cycles.get(a.id);
    if (c && c.toPay > 0 && c.due <= limit) soon.push({ date: c.due, el: cardDueRow(a, c) });
  }
  if (soon.length && !view.hiddenSections.includes('due')) {
    soon.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    root.append(h('div', { class: 'section-title', text: 'Vencimientos' }), h('div', { class: 'list' }, soon.map((s) => s.el)));
  }

  const active = d.accounts.filter((a) => !a.archived);
  const archived = d.accounts.filter((a) => a.archived);
  const accBox = collapsible('accounts', 'Cuentas', `${active.length}`);
  accBox.body.append(h('div', { class: 'list' }, active.map((a) => accountRow(a, d))));
  root.append(accBox.el);
  if (archived.length) {
    root.append(h('div', { class: 'section-title', text: 'Archivadas' }), h('div', { class: 'list' }, archived.map((a) => accountRow(a, d))));
  }
  root.append(h('div', { class: 'row wrap', style: 'margin-top:14px' },
    h('button', { class: 'btn', type: 'button', onclick: () => openAccountForm(), text: '＋ Nueva cuenta' })));
}

// ---------- Meta de ahorro (cajita) ----------
const sumBy = (arr, f) => arr.reduce((t, x) => t + f(x), 0);

const goalName = (g, acc) => (g.name && g.name.trim()) || acc.name;

function savingsGoals(d) {
  return d.goals.filter((g) => d.accById.has(g.accountId) && !d.accById.get(g.accountId).archived);
}

function renderSavings(root, d) {
  const goals = savingsGoals(d);
  const box = collapsible('savings', 'Meta de ahorro');
  root.append(box.el);
  if (!goals.length) {
    box.body.append(h('div', { class: 'chart-card' },
      h('p', { class: 'hint', text: 'Define cuánto quieres ahorrar al mes y al año en tu cajita, y sigue cuánto aportas cada mes.' }),
      h('button', { class: 'btn primary', type: 'button', text: 'Definir meta de ahorro', onclick: () => openGoalForm() })));
    return;
  }
  const today = todayStr();
  const month = monthOf(today);
  const year = Number(today.slice(0, 4));
  for (const g of goals) {
    const acc = d.accById.get(g.accountId);
    const cur = acc.currency;
    const { monthly, annual } = goalTargets(g);
    const m = savingsMonth(acc.id, d.movs, month);
    const saved = sumBy(savingsYear(acc.id, d.movs, year), (x) => x.aportes);
    const monthPct = monthly > 0 ? Math.max(0, m.aportes) / monthly : 0;
    const yearPct = annual > 0 ? Math.max(0, saved) / annual : 0;
    const monthDone = m.aportes >= monthly;
    const yearDone = saved >= annual;
    const need = yearNeeded(annual, saved, today, monthDone);
    const behind = !yearDone && (need.left === 0 || need.perMonth > monthly);
    const meter = (pct, label, state, aria) => h('div', { class: 'meter ' + state, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct * 100)), 'aria-label': aria },
      h('div', { style: `width:${Math.min(pct, 1) * 100}%` }));
    box.body.append(h('div', { class: 'chart-card sav' },
      h('div', { class: 'row between' },
        h('div', {}, h('h3', { text: goalName(g, acc) }), g.name && g.name.trim() && g.name.trim() !== acc.name && h('div', { class: 'sub', text: acc.name })),
        h('strong', { text: formatMoney(d.balances.get(acc.id) || 0, cur) })),
      h('div', { class: 'bud' },
        h('div', { class: 'row' }, h('span', { text: 'Este mes' }), h('span', { text: `${formatMoney(m.aportes, cur)} / ${formatMoney(monthly, cur)}` })),
        meter(monthPct, '', 'ok', `Meta del mes: ${Math.round(monthPct * 100)}%`),
        h('div', { class: 'state', text: monthDone ? '✓ Meta del mes cumplida' : `Te faltan ${formatMoney(monthly - m.aportes, cur)}` })),
      h('div', { class: 'bud' },
        h('div', { class: 'row' }, h('span', { text: `Este año (${year})` }), h('span', { text: `${formatMoney(saved, cur)} / ${formatMoney(annual, cur)}` })),
        meter(yearPct, '', behind ? 'warn' : 'ok', `Meta del año: ${Math.round(yearPct * 100)}%`),
        h('div', { class: 'state', text: yearDone ? '✓ Meta del año cumplida'
          : need.left === 0 ? `⚠ Faltaron ${formatMoney(need.missing, cur)} para la meta del año`
          : behind ? `⚠ Para llegar necesitas ahorrar ${formatMoney(need.perMonth, cur)} al mes (tu meta mensual es ${formatMoney(monthly, cur)})`
          : `✓ Vas bien: con ${formatMoney(need.perMonth, cur)} al mes llegas a la meta` })),
      m.rendimientos > 0 && h('p', { class: 'hint', style: 'margin:6px 0 0', text: `Rendimientos este mes: ${formatMoney(m.rendimientos, cur)} (no cuentan como aporte)` }),
      h('div', { class: 'row wrap', style: 'margin-top:10px' },
        h('button', { class: 'btn primary', type: 'button', text: '＋ Aportar', onclick: () => openMovForm(null, { kind: 'transferencia', toAccountId: acc.id, amount: '' }) }),
        h('button', { class: 'btn', type: 'button', text: 'Editar meta', onclick: () => openGoalForm(g) }))));
  }
  box.body.append(h('div', { class: 'row wrap', style: 'margin:-4px 0 12px' },
    h('button', { class: 'btn', type: 'button', text: '＋ Otra meta de ahorro', onclick: () => openGoalForm() })));
}

function openGoalForm(existing) {
  const d = ui.data;
  if (!d) return;
  const used = new Set(d.goals.map((g) => g.accountId));
  const accs = d.accounts.filter((a) => a.type === 'ahorro' && !a.archived && (!used.has(a.id) || (existing && existing.accountId === a.id)));
  if (!accs.length) {
    const none = d.accounts.some((a) => a.type === 'ahorro' && !a.archived);
    openSheet(h('div', { class: 'form' },
      h('h3', { text: 'Meta de ahorro' }),
      h('p', { class: 'hint', text: none
        ? 'Todas tus cuentas de ahorro ya tienen una meta. Crea otra cuenta de ahorro si quieres una meta más.'
        : 'Primero crea la cuenta de ahorro donde guardas ese dinero (por ejemplo, tu cajita de Nu). Después le defines la meta.' }),
      h('div', { class: 'row end wrap' },
        h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }),
        h('button', { class: 'btn primary', type: 'button', text: 'Crear cuenta de ahorro', onclick: () => openAccountForm(null, { type: 'ahorro', name: 'Nubank cajita' }) }))));
    return;
  }
  const curOf = (id) => (d.accById.get(id) ? d.accById.get(id).currency : 'COP');
  const s = existing
    ? {
        accountId: existing.accountId,
        name: existing.name || '',
        monthly: existing.monthly ? toInput(existing.monthly, curOf(existing.accountId)) : '',
        annual: existing.annual ? toInput(existing.annual, curOf(existing.accountId)) : '',
      }
    : { accountId: accs[0].id, name: '', monthly: '', annual: '' };
  const body = h('div');
  const err = h('p', { class: 'error', hidden: true });
  const read = () => {
    const f = body.querySelector('form');
    if (!f) return;
    for (const k of ['accountId', 'name', 'monthly', 'annual']) if (f.elements[k]) s[k] = f.elements[k].value;
  };
  const rebuild = () => { read(); build(); };

  async function submit(ev) {
    ev.preventDefault();
    read();
    const cur = curOf(s.accountId);
    const monthly = s.monthly.trim() ? parseAmount(s.monthly, cur) : 0;
    const annual = s.annual.trim() ? parseAmount(s.annual, cur) : 0;
    if (s.monthly.trim() && !monthly) { err.textContent = 'Revisa la meta mensual.'; err.hidden = false; return; }
    if (s.annual.trim() && !annual) { err.textContent = 'Revisa la meta anual.'; err.hidden = false; return; }
    if (!(monthly > 0) && !(annual > 0)) { err.textContent = 'Pon al menos una meta: mensual o anual.'; err.hidden = false; return; }
    closeSheet();
    await saveRecord({
      ...(existing || {}),
      col: 'metas',
      id: `meta-${s.accountId}`,
      accountId: s.accountId,
      name: s.name.trim().slice(0, 40),
      monthly: monthly || 0,
      annual: annual || 0,
      deleted: false,
      createdAt: existing ? existing.createdAt : Date.now(),
    });
  }

  function build() {
    err.hidden = true;
    const cur = curOf(s.accountId);
    body.replaceChildren(h('form', { class: 'form', onsubmit: submit },
      h('h3', { text: existing ? 'Editar meta de ahorro' : 'Meta de ahorro' }),
      h('label', {}, 'Cuenta de ahorro',
        h('select', { name: 'accountId', disabled: !!existing, onchange: rebuild },
          accs.map((a) => opt(a.id, `${a.name} (${a.currency})`, a.id === s.accountId)))),
      h('label', {}, 'Nombre de la meta (opcional)',
        h('input', { type: 'text', name: 'name', maxlength: '40', autocomplete: 'off', placeholder: 'Ej: Fondo de emergencia', value: s.name })),
      h('label', {}, `Meta mensual (${cur})`,
        h('input', { class: 'money', type: 'text', name: 'monthly', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', value: s.monthly })),
      h('label', {}, `Meta anual (${cur}, opcional)`,
        h('input', { type: 'text', name: 'annual', inputmode: 'decimal', placeholder: 'Si la dejas vacía, será 12 veces la mensual', autocomplete: 'off', value: s.annual })),
      h('p', { class: 'hint', text: 'Cuenta como aporte lo que transfieres a esta cuenta cada mes. Si retiras plata de ella, el aporte baja. Los rendimientos (intereses) no cuentan como aporte.' }),
      err,
      h('div', { class: 'row between wrap' },
        existing ? h('button', { class: 'btn danger', type: 'button', text: 'Quitar meta', onclick: async () => {
          if (!confirm('¿Quitar esta meta? La cuenta y sus movimientos no se tocan.')) return;
          closeSheet();
          await saveRecord({ ...existing, deleted: true });
        } }) : h('span'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }),
          h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' })))));
  }

  build();
  openSheet(body);
}

function movRow(m, d) {
  if (m.kind === 'inv') {
    const acc = d.accById.get(m.accountId);
    return h('button', { type: 'button', class: 'item', onclick: () => openPositionDetail(m.symbol) },
      h('div', { class: 'main' },
        h('div', { class: 'title', text: m.label }),
        h('div', { class: 'sub', text: ['Inversión', acc ? acc.name : null].filter(Boolean).join(' · ') })),
      h('div', { class: 'amt ' + (m.effect >= 0 ? 'pos' : 'neg'), text: (m.effect >= 0 ? '+' : '−') + formatMoney(Math.abs(m.effect), acc ? acc.currency : 'USD') }));
  }
  if (m.kind === 'deuda' || m.kind === 'abono') {
    const acc = d.accById.get(m.accountId);
    const cls = m.effect >= 0 ? 'pos' : 'neg';
    return h('button', { type: 'button', class: 'item', onclick: () => openDebtDetail(m.debtId) },
      h('div', { class: 'main' },
        h('div', { class: 'title', text: m.label }),
        h('div', { class: 'sub', text: [m.kind === 'deuda' ? 'Préstamo' : 'Abono', acc ? acc.name : null].filter(Boolean).join(' · ') })),
      h('div', { class: 'amt ' + cls, text: (m.effect >= 0 ? '+' : '−') + formatMoney(Math.abs(m.effect), acc ? acc.currency : 'COP') }));
  }
  const from = d.accById.get(m.accountId);
  const to = d.accById.get(m.toAccountId);
  const cat = d.catById.get(m.categoryId);
  const fromCur = from ? from.currency : 'COP';
  const toCur = to ? to.currency : 'COP';
  let title;
  let sub;
  let amt;
  let small = '';
  let cls = '';
  if (m.kind === 'transferencia') {
    title = `${from ? from.name : '?'} → ${to ? to.name : '?'}`;
    sub = m.note || 'Transferencia';
    const f = ui.filterAccount;
    if (f && f === m.toAccountId && f !== m.accountId) { amt = '+' + formatMoney(m.toAmount ?? m.amount, toCur); cls = 'pos'; }
    else if (f && f === m.accountId) { amt = '−' + formatMoney(m.amount, fromCur); cls = 'neg'; }
    else {
      amt = formatMoney(m.amount, fromCur);
      if (fromCur !== toCur) small = `recibe ${formatMoney(m.toAmount ?? m.amount, toCur)}`;
    }
  } else {
    title = cat ? cat.name : 'Sin categoría';
    sub = [m.note, hasCuotas(m) ? `${m.cuotas.n} cuotas` : null, from ? from.name : null].filter(Boolean).join(' · ');
    amt = (m.kind === 'ingreso' ? '+' : '−') + formatMoney(m.amount, fromCur);
    cls = m.kind === 'ingreso' ? 'pos' : 'neg';
  }
  const open = m.virtual ? () => { const p = d.realMovs.find((x) => x.id === m.parentId); if (p) openMovForm(p); } : () => openMovForm(m);
  return h('button', { type: 'button', class: 'item', onclick: open },
    h('div', { class: 'main' }, h('div', { class: 'title', text: title }), h('div', { class: 'sub', text: sub })),
    h('div', { class: 'amt ' + cls }, amt, small && h('small', { text: small })));
}

// ---------- Movimientos: búsqueda, filtros y selección ----------
const filtersActive = () => !!(ui.q.trim() || ui.fKind || ui.fCat || ui.filterAccount || ui.period !== 'mes');
let searchTimer = null;

function renderMovs(d) {
  const root = $('#movs-body');
  const ae = document.activeElement;
  const hadFocus = !!(ae && ae.classList && ae.classList.contains('search') && root.contains(ae));
  const caret = hadFocus ? ae.selectionStart : 0;
  root.replaceChildren();

  // Búsqueda
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Buscar: nota, categoría, cuenta o monto', 'aria-label': 'Buscar movimientos', value: ui.q,
    oninput: (e) => { ui.q = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(render, 250); } });
  const nFilters = [ui.fKind, ui.fCat, ui.filterAccount, ui.period !== 'mes'].filter(Boolean).length;
  root.append(h('div', { class: 'searchbar' }, search,
    h('button', { class: 'btn' + (ui.showFilters ? ' active' : ''), type: 'button', 'aria-expanded': String(!!ui.showFilters),
      text: nFilters ? `Filtros (${nFilters})` : 'Filtros', onclick: () => { ui.showFilters = !ui.showFilters; render(); } })));
  if (hadFocus) queueMicrotask(() => { search.focus(); search.setSelectionRange(caret, caret); });

  // Panel de filtros
  if (ui.showFilters) {
    const seg = (opts, cur, onpick) => h('div', { class: 'seg', style: `grid-template-columns:repeat(${opts.length},1fr)` },
      opts.map(([k, label]) => h('button', { type: 'button', class: k === cur ? 'on' : '', text: label, onclick: () => onpick(k) })));
    const cats = d.cats.filter((c) => !ui.fKind || c.kind === ui.fKind);
    root.append(h('div', { class: 'card filters-panel' },
      h('div', { class: 'section-title', text: 'Tipo' }),
      seg([['', 'Todos'], ['gasto', 'Gastos'], ['ingreso', 'Ingresos'], ['transferencia', 'Transf.']], ui.fKind, (k) => { ui.fKind = k; if (k === 'transferencia') ui.fCat = ''; render(); }),
      ui.fKind !== 'transferencia' && h('label', {}, 'Categoría',
        h('select', { onchange: (e) => { ui.fCat = e.target.value; render(); } },
          opt('', 'Todas', !ui.fCat), opt('-', 'Sin categoría', ui.fCat === '-'),
          cats.map((c) => opt(c.id, c.name + (c.archived ? ' (archivada)' : ''), ui.fCat === c.id)))),
      h('label', {}, 'Cuenta',
        h('select', { 'aria-label': 'Filtrar por cuenta', onchange: (e) => { ui.filterAccount = e.target.value; render(); } },
          opt('', 'Todas las cuentas', !ui.filterAccount),
          d.accounts.map((a) => opt(a.id, a.name + (a.archived ? ' (archivada)' : ''), ui.filterAccount === a.id)))),
      h('div', { class: 'section-title', text: 'Periodo' }),
      seg([['mes', 'Un mes'], ['todo', 'Todo'], ['rango', 'Fechas']], ui.period, (k) => { ui.period = k; render(); }),
      ui.period === 'rango' && h('div', { class: 'row wrap', style: 'gap:8px' },
        h('label', { style: 'flex:1' }, 'Desde', h('input', { type: 'date', value: ui.from, onchange: (e) => { ui.from = e.target.value; render(); } })),
        h('label', { style: 'flex:1' }, 'Hasta', h('input', { type: 'date', value: ui.to, onchange: (e) => { ui.to = e.target.value; render(); } }))),
      filtersActive() && h('button', { class: 'link-btn', type: 'button', text: 'Quitar búsqueda y filtros', onclick: () => {
        Object.assign(ui, { q: '', fKind: '', fCat: '', filterAccount: '', period: 'mes', from: '', to: '' });
        render();
      } })));
  }

  if (ui.period === 'mes') {
    root.append(h('div', { class: 'monthbar' },
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Mes anterior', text: '◀', onclick: () => { ui.month = shiftMonth(ui.month, -1); render(); } }),
      h('strong', { text: monthLabel(ui.month) }),
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Mes siguiente', text: '▶', onclick: () => { ui.month = shiftMonth(ui.month, 1); render(); } })));
  }

  const from = ui.period === 'mes' ? ui.month + '-01' : ui.period === 'rango' ? ui.from : '';
  const to = ui.period === 'mes' ? monthEnd(ui.month) : ui.period === 'rango' ? ui.to : '';
  const list = searchMovs([...d.movs, ...d.flows], { q: ui.q, kind: ui.fKind, categoryId: ui.fCat, accountId: ui.filterAccount, from, to },
    { catById: d.catById, accById: d.accById, dec });

  const tot = listTotals(list, d.accById);
  const parts = Object.entries(tot).map(([cur, t]) => `${cur}: ingresos ${formatMoney(t.ingresos, cur)} · gastos ${formatMoney(t.gastos, cur)}`);
  const searching = filtersActive();
  root.append(h('p', { class: 'totals' },
    searching ? `${list.length} resultado(s)${parts.length ? ' · ' : ''}` : '',
    parts.join('   |   ') || (searching ? '' : 'Sin ingresos ni gastos este mes.')));

  const selectableShown = list.some((m) => !m.virtual && ['gasto', 'ingreso', 'transferencia'].includes(m.kind));
  if (!ui.selecting) {
    root.append(h('div', { class: 'row between', style: 'margin:-4px 0 4px' },
      h('button', { class: 'link-btn', type: 'button', text: '⇪ Importar extracto', onclick: () => openImport() }),
      selectableShown ? h('button', { class: 'link-btn', type: 'button', text: 'Seleccionar varios', onclick: () => { ui.selecting = true; ui.sel = new Set(); render(); } }) : h('span')));
  }
  if (!list.length) {
    root.append(h('div', { class: 'empty' },
      h('p', { text: searching ? 'No hay movimientos con esa búsqueda o filtros.' : 'No hay movimientos en este mes.' }),
      searching
        ? h('button', { class: 'btn', type: 'button', text: 'Quitar búsqueda y filtros', onclick: () => { Object.assign(ui, { q: '', fKind: '', fCat: '', filterAccount: '', period: 'mes', from: '', to: '' }); render(); } })
        : h('button', { class: 'btn primary', type: 'button', onclick: () => openMovForm(), text: '＋ Añadir movimiento' })));
    return;
  }

  // Selección para cambiar categoría o eliminar varios a la vez
  const selectable = (m) => !m.virtual && ['gasto', 'ingreso', 'transferencia'].includes(m.kind);
  if (ui.selecting) {
    const shown = list.filter(selectable);
    const all = shown.length && shown.every((m) => ui.sel.has(m.id));
    root.append(h('div', { class: 'row between', style: 'margin:-4px 0 4px' },
      h('button', { class: 'link-btn', type: 'button', text: all ? 'Quitar todos' : `Seleccionar los ${shown.length}`, onclick: () => {
        ui.sel = all ? new Set() : new Set(shown.map((m) => m.id));
        render();
      } }),
      h('span', { class: 'hint', text: `${ui.sel.size} seleccionado(s)` })));
  }

  let lastDate = null;
  let ul = null;
  for (const m of list) {
    if (m.date !== lastDate) {
      root.append(h('div', { class: 'day', text: dayLabel(m.date) }));
      ul = h('div', { class: 'list' });
      root.append(ul);
      lastDate = m.date;
    }
    const row = movRow(m, d);
    if (ui.selecting && selectable(m)) {
      const on = ui.sel.has(m.id);
      row.setAttribute('tabindex', '-1');
      ul.append(h('div', { class: 'selrow' + (on ? ' on' : ''), role: 'checkbox', 'aria-checked': String(on), tabindex: '0',
        onclick: () => { if (on) ui.sel.delete(m.id); else ui.sel.add(m.id); render(); },
        onkeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.currentTarget.click(); } } },
        h('span', { class: 'tick', 'aria-hidden': 'true', text: on ? '✓' : '' }), row));
    } else ul.append(row);
  }

  if (ui.selecting) {
    const picked = d.realMovs.filter((m) => ui.sel.has(m.id));
    const catSel = h('select', { 'aria-label': 'Nueva categoría' }, opt('', 'Cambiar categoría a…', true),
      h('optgroup', { label: 'Gastos' }, d.cats.filter((c) => c.kind === 'gasto' && !c.archived).map((c) => opt(c.id, c.name))),
      h('optgroup', { label: 'Ingresos' }, d.cats.filter((c) => c.kind === 'ingreso' && !c.archived).map((c) => opt(c.id, c.name))));
    root.append(h('div', { class: 'selbar' },
      catSel,
      h('button', { class: 'btn primary', type: 'button', text: 'Aplicar', disabled: !picked.length, onclick: async () => {
        const cat = d.catById.get(catSel.value);
        if (!cat) return setStatus('Elige una categoría.', 'warn');
        const ok = picked.filter((m) => m.kind === cat.kind);
        const skipped = picked.length - ok.length;
        if (!ok.length) return setStatus(`Ninguno de los seleccionados es un ${cat.kind}.`, 'warn');
        ui.selecting = false;
        await saveRecords(ok.map((m) => ({ ...m, categoryId: cat.id })));
        setStatus(`${ok.length} movimiento(s) pasaron a «${cat.name}»${skipped ? `; ${skipped} no, porque no son ${cat.kind === 'gasto' ? 'gastos' : 'ingresos'}` : ''}.`, 'ok');
      } }),
      h('button', { class: 'btn danger', type: 'button', text: 'Eliminar', disabled: !picked.length, onclick: async () => {
        if (!confirm(`¿Eliminar ${picked.length} movimiento(s)? Podrás recuperarlos desde la Papelera durante ${TRASH_DAYS} días.`)) return;
        const trash = 'del-' + crypto.randomUUID().slice(0, 8);
        ui.selecting = false;
        await saveRecords(picked.map((m) => ({ ...m, deleted: true, trash })));
        setStatus(`${picked.length} movimiento(s) eliminados.`, 'ok');
      } }),
      h('button', { class: 'btn', type: 'button', text: 'Listo', onclick: () => { ui.selecting = false; render(); } })));
  }
}





// ---------- Comparar con un índice ----------
// Historial de cierres guardado en este dispositivo (no se sincroniza): { on: fecha, start, data: { SÍMBOLO: serie } }.
const pctTxt1 = (p) => (p === null || p === undefined ? '—' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${(Math.abs(p) * 100).toFixed(1).replace('.', ',')}%`);
const MAX_BENCH = 3;
const BENCH_COLORS = ['var(--s2)', 'var(--s3)', 'var(--s4)'];
let seriesCache = null;
async function getSeriesCache() {
  if (!seriesCache) seriesCache = (await store.getMeta('series')) || { on: '', start: '', data: {} };
  return seriesCache;
}

function benchSymbols(d) {
  return (d.benchCfg && Array.isArray(d.benchCfg.symbols) ? d.benchCfg.symbols : ['VOO', 'QQQ']).slice(0, MAX_BENCH);
}

async function setBenchSymbols(list) {
  await saveRecord({ col: 'config', id: 'benchmarks', symbols: list, deleted: false });
}

function renderBenchmark(root, d) {
  const box = collapsible('inv-bench', 'Comparar con un índice');
  root.append(box.el);
  const sel = benchSymbols(d);
  const usdOps = d.ops.filter((o) => o.currency === 'USD');
  const chips = h('div', { class: 'chips' }, BENCHMARKS.map((b) => {
    const on = sel.includes(b.symbol);
    return h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), title: b.hint, onclick: () => {
      if (on) return setBenchSymbols(sel.filter((x) => x !== b.symbol));
      if (sel.length >= MAX_BENCH) { ui.benchMsg = `Puedes comparar con hasta ${MAX_BENCH} a la vez; quita uno primero.`; return render(); }
      return setBenchSymbols([...sel, b.symbol]);
    } }, h('strong', { text: b.symbol }), ` ${b.name}`);
  }), sel.filter((x) => !BENCHMARKS.some((b) => b.symbol === x)).map((x) =>
    h('button', { type: 'button', class: 'chip on', 'aria-pressed': 'true', onclick: () => setBenchSymbols(sel.filter((y) => y !== x)) }, h('strong', { text: x }), ' ✕')),
  h('button', { type: 'button', class: 'chip', text: '＋ Otro', onclick: () => {
    const v = normSymbol(prompt('Símbolo de un ETF o acción de EE. UU. (por ejemplo SPY o SCHD):') || '');
    if (!v) return;
    if (sel.includes(v)) return;
    if (sel.length >= MAX_BENCH) { ui.benchMsg = `Puedes comparar con hasta ${MAX_BENCH} a la vez; quita uno primero.`; return render(); }
    setBenchSymbols([...sel, v]);
  } }));
  box.body.append(h('p', { class: 'hint', style: 'margin:0 0 8px', text: '¿Te habría ido mejor poniendo cada compra en un índice? Elige con cuáles comparar (cada índice se sigue con su ETF).' }), chips);
  if (ui.benchMsg) { box.body.append(h('p', { class: 'warn-text', text: ui.benchMsg })); ui.benchMsg = ''; }
  const out = h('div', { class: 'bench-out' });
  box.body.append(out);
  if (!usdOps.some((o) => o.kind === 'compra')) { out.append(h('p', { class: 'hint', text: 'Registra tus compras en dólares para comparar.' })); return; }
  if (!sel.length) { out.append(h('p', { class: 'hint', text: 'Elige al menos un índice.' })); return; }
  if (!getPxKey()) {
    out.append(h('p', { class: 'hint', text: 'Para comparar hace falta el historial de precios, que se trae con tu clave de Twelve Data (Ajustes → Precios de inversiones).' }));
    return;
  }
  out.append(h('p', { class: 'hint', text: 'Cargando historial de precios…' }));
  fillBenchmark(out, d, sel).catch((e) => { out.replaceChildren(h('p', { class: 'error', text: e.message || String(e) })); });
}

async function fillBenchmark(out, d, sel, force = false) {
  const usdOps = d.ops.filter((o) => o.currency === 'USD');
  // Una semana antes de la primera compra: si fue en fin de semana o festivo, se usa el cierre anterior.
  const start = addDays(usdOps.map((o) => o.date).sort()[0], -7);
  const held = [...new Set(usdOps.filter((o) => o.kind !== 'dividendo').map((o) => o.symbol))];
  const need = [...new Set([...sel, ...held])];
  const today = todayStr();
  const cache = await getSeriesCache();
  const fresh = (sym) => cache.on === today && cache.start <= start && cache.data[sym];
  const missing = need.filter((x) => !fresh(x));
  let problems = [];
  if (missing.length && (force || ui.seriesTried !== today + need.join())) {
    ui.seriesTried = today + need.join();
    // Si cambió el rango o el día, se piden todos (1 crédito por símbolo, máx. 8 por consulta).
    const ask = cache.on === today && cache.start <= start ? missing : need;
    const r = await fetchSeries(ask, start, getPxKey());
    if (r.fatal) problems.push(r.fatal);
    for (const [k, v] of Object.entries(r.errors)) problems.push(`${k}: ${v}.`);
    if (r.skipped.length) problems.push(`Por el límite gratis no se consultaron: ${r.skipped.join(', ')}.`);
    if (Object.keys(r.series).length) {
      if (!(cache.on === today && cache.start <= start)) { cache.data = {}; cache.on = today; cache.start = start; }
      Object.assign(cache.data, r.series);
      await store.setMeta('series', cache);
    }
  }
  if (!out.isConnected) return;
  const hist = cache.data;
  const usdTotal = d.inv.totals.USD ? d.inv.totals.USD.value : 0;
  const mine = actualResult(usdOps, usdTotal);
  const res = sel.map((sym) => ({ sym, r: hist[sym] ? benchmarkResult(usdOps, hist[sym], today) : null }));
  const row = (label, r, main) => h('tr', { class: main ? 'main' : '' },
    h('td', { text: label }),
    h('td', { class: 'num', text: r ? formatMoney(r.value, 'USD') : '—' }),
    h('td', { class: 'num ' + (r ? toneOf(r.gain) : ''), text: r ? `${signedMoney(r.gain, 'USD')}` : '—' }),
    h('td', { class: 'num ' + (r ? toneOf(r.gain) : ''), text: r ? pctTxt1(r.pct) : '—' }));
  const nodes = [];
  const first = res.find((x) => x.r);
  if (first) {
    const diff = mine.gain - first.r.gain;
    nodes.push(h('p', { class: 'bench-verdict ' + toneOf(diff) },
      diff >= 0 ? `Vas ${formatMoney(diff, 'USD')} por encima de ${first.sym} (${benchName(first.sym)}).` : `Vas ${formatMoney(-diff, 'USD')} por debajo de ${first.sym} (${benchName(first.sym)}): con ese índice tendrías más.`));
  }
  nodes.push(h('table', { class: 'tbl bench-tbl' },
    h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { class: 'num', text: 'Valor hoy' }), h('th', { class: 'num', text: 'Ganancia' }), h('th', { class: 'num', text: '%' }))),
    h('tbody', {}, row('Tu portafolio', mine, true), res.map((x) => row(`Con ${x.sym}`, x.r)))));

  // Gráfica de valor en el tiempo
  const okBench = sel.filter((x) => hist[x]);
  if (okBench.length && held.every((x) => hist[x])) {
    const dates = sampleDates(addDays(start, 7), today);
    const lines = historyLines(usdOps, hist, okBench, dates);
    const pt = (p, i, arr) => ({ ...p, full: fmtDayFull(p.date),
      label: i === arr.length - 1 ? 'Hoy' : i === 0 || p.date.slice(0, 7) !== arr[i - 1].date.slice(0, 7) ? benchMonth(p.date) : '' });
    const series = [
      { name: 'Tu portafolio', short: 'Tú', color: 'var(--s1)', main: true, points: lines.mine.map(pt) },
      ...okBench.map((sym, i) => ({ name: `Con ${sym} (${benchName(sym)})`, short: sym, color: BENCH_COLORS[i], points: lines.bench[sym].map(pt) })),
    ];
    if (series[0].points.some((p) => p.value !== null)) {
      const card = h('div', { class: 'chart-card bench-chart' },
        h('h3', { text: 'Valor en el tiempo' }),
        h('div', { class: 'legend' }, series.map((sr) => h('span', {}, h('i', { style: `background:${sr.color}` }), sr.name))));
      nodes.push(card);
      requestAnimationFrame(() => {
        if (!card.isConnected) return;
        card.append(multiLine(card.clientWidth - 28, series, 'USD', 'Valor de tu portafolio frente a los índices'),
          tableView(['Fecha', ...series.map((sr) => sr.short)], series[0].points.map((p, i) => [p.full, ...series.map((sr) => (sr.points[i].value === null ? '—' : formatMoney(sr.points[i].value, 'USD')))])));
      });
    }
  } else if (okBench.length) {
    problems.push('Falta el historial de alguna de tus acciones para dibujar la gráfica.');
  }
  const noData = sel.filter((x) => !hist[x] && !problems.some((p) => p.startsWith(x + ':')));
  if (noData.length) problems.push(`Sin historial de precios para ${noData.join(', ')}.`);
  if (problems.length) nodes.push(h('p', { class: 'hint', text: problems.join(' ') }));
  nodes.push(h('p', { class: 'hint', style: 'margin-top:8px' },
    'Simula que cada compra y venta la hubieras hecho en el índice el mismo día y por el mismo monto. Tus dividendos cuentan; los del índice no. Precios de cierre, una vez al día. ',
    h('button', { class: 'link-btn', type: 'button', text: 'Volver a consultar', onclick: () => { out.replaceChildren(h('p', { class: 'hint', text: 'Consultando…' })); fillBenchmark(out, ui.data, sel, true); } })));
  out.replaceChildren(...nodes);
}
const benchMonth = (ds) => { const [y, m] = ds.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('es-CO', { month: 'short' }).replace('.', '') + (m === 1 ? ` ${String(y).slice(2)}` : ''); };
const fmtDayFull = (ds) => { const [y, m, dd] = ds.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }); };

// ---------- Asignación objetivo y rebalanceo ----------
function renderAllocation(root, d) {
  const box = collapsible('inv-alloc', 'Asignación y rebalanceo');
  root.append(box.el);
  const rows = d.inv.rows.filter((r) => r.open && r.currency === 'USD').map((r) => ({ symbol: r.symbol, value: r.value }));
  const targets = d.allocCfg && Array.isArray(d.allocCfg.targets) ? d.allocCfg.targets.filter((t) => t.pct > 0) : [];
  if (!targets.length) {
    box.body.append(h('p', { class: 'hint', text: 'Define qué porcentaje quieres de cada ETF o acción (por ejemplo 70 % VOO, 20 % VXUS, 10 % acciones sueltas). La app te muestra qué tan lejos estás y en qué poner el próximo aporte, sin vender nada.' }),
      h('button', { class: 'btn primary', type: 'button', text: 'Definir objetivos', onclick: () => openAllocForm(rows, targets) }));
    return;
  }
  const al = allocation(rows, targets);
  const label = (b) => (b.symbol === OTHER ? `Otras${b.members && b.members.length ? ` (${b.members.join(', ')})` : ''}` : b.symbol);
  box.body.append(h('div', { class: 'alloc' }, al.list.map((b) => {
    const off = Math.abs(b.diff) >= 5;
    return h('div', { class: 'alloc-row' },
      h('div', { class: 'alloc-head' },
        h('strong', { text: label(b) }),
        h('span', { class: 'hint', text: `${b.actual.toFixed(0)} % de ${b.target.toFixed(0)} %` })),
      h('div', { class: 'alloc-track', role: 'img', 'aria-label': `${label(b)}: ${b.actual.toFixed(0)} % actual, objetivo ${b.target.toFixed(0)} %` },
        h('div', { class: 'alloc-fill', style: `width:${Math.min(100, b.actual).toFixed(1)}%` }),
        h('div', { class: 'alloc-target', style: `left:${Math.min(100, b.target).toFixed(1)}%` })),
      h('div', { class: 'alloc-note ' + (off ? 'warn' : ''), text: Math.abs(b.diff) < 1 ? '✓ en el objetivo'
        : b.diff < 0 ? `${off ? '⚠ ' : ''}faltan ${(-b.diff).toFixed(0)} puntos (${formatMoney(b.gapValue, 'USD')})`
        : `${off ? '⚠ ' : ''}sobran ${b.diff.toFixed(0)} puntos (${formatMoney(-b.gapValue, 'USD')})` }));
  })), h('p', { class: 'hint', style: 'margin:6px 0 10px', text: 'La barra es lo que tienes hoy; la línea vertical, tu objetivo.' }));

  const result = h('div', { class: 'list' });
  const amountIn = h('input', { type: 'text', inputmode: 'decimal', class: 'money', placeholder: 'Ej: 200', value: ui.allocAmount || '', 'aria-label': 'Monto del próximo aporte en dólares' });
  const calc = () => {
    ui.allocAmount = amountIn.value;
    const amt = parseAmount(amountIn.value, 'USD');
    result.replaceChildren();
    if (!amt) return;
    const plan = contributionPlan(rows, targets, amt);
    if (!plan.length) { result.append(h('p', { class: 'hint', text: 'Define objetivos para tus ETF o acciones para recibir una sugerencia.' })); return; }
    for (const p of plan) {
      result.append(h('button', { type: 'button', class: 'item', onclick: () => openInvForm(null, { symbol: p.symbol, kind: 'compra' }) },
        h('div', { class: 'main' }, h('div', { class: 'title', text: `Compra ${p.symbol}` }), h('div', { class: 'sub', text: 'Toca para registrar la compra cuando la hagas' })),
        h('div', { class: 'amt', text: formatMoney(p.amount, 'USD') })));
    }
  };
  amountIn.addEventListener('input', calc);
  box.body.append(h('label', {}, '¿Cuánto vas a invertir ahora? (US$)', amountIn), result,
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn', type: 'button', text: 'Editar objetivos', onclick: () => openAllocForm(rows, targets) })));
  calc();
}

function openAllocForm(rows, targets) {
  const syms = [...new Set([...targets.map((t) => t.symbol), ...rows.map((r) => r.symbol)])];
  const state = syms.map((sym) => ({ symbol: sym, pct: (targets.find((t) => t.symbol === sym) || {}).pct || '' }));
  const err = h('p', { class: 'error', hidden: true });
  const sumEl = h('p', { class: 'hint' });
  const list = h('div', { class: 'list' });
  const total = () => state.reduce((a, x) => a + (Number(String(x.pct).replace(',', '.')) || 0), 0);
  const upd = () => {
    const t = total();
    sumEl.textContent = t > 100 ? `Suman ${t} %: no puede pasar de 100.` : `Suman ${t} %.${t < 100 ? ` El ${100 - t} % que sobra queda para «Otras» (lo que no tiene objetivo).` : ''}`;
    sumEl.className = t > 100 ? 'error' : 'hint';
  };
  const draw = () => {
    list.replaceChildren(...state.map((x) => h('div', { class: 'item alloc-edit' },
      h('div', { class: 'main' }, h('div', { class: 'title', text: x.symbol })),
      h('label', { class: 'pct' }, h('input', { type: 'text', inputmode: 'decimal', value: String(x.pct), 'aria-label': `Porcentaje objetivo de ${x.symbol}`, oninput: (e) => { x.pct = e.target.value; upd(); } }), ' %'))));
    upd();
  };
  draw();
  openSheet(h('form', { class: 'form', onsubmit: async (ev) => {
    ev.preventDefault();
    const t = total();
    if (t > 100) { err.textContent = 'Los porcentajes no pueden sumar más de 100.'; err.hidden = false; return; }
    const clean = state.map((x) => ({ symbol: x.symbol, pct: Math.round((Number(String(x.pct).replace(',', '.')) || 0) * 10) / 10 })).filter((x) => x.pct > 0);
    closeSheet();
    await saveRecord({ col: 'config', id: 'asignacion', targets: clean, deleted: false });
  } },
    h('h3', { text: 'Objetivo de asignación' }),
    h('p', { class: 'hint', text: 'Qué porcentaje de tu portafolio en dólares quieres en cada uno. Deja en blanco lo que no quieras fijar.' }),
    list,
    h('button', { class: 'btn', type: 'button', text: '＋ Agregar símbolo', onclick: () => {
      const v = normSymbol(prompt('Símbolo (por ejemplo VXUS):') || '');
      if (v && !state.some((x) => x.symbol === v)) { state.push({ symbol: v, pct: '' }); draw(); }
    } }),
    sumEl, err,
    h('div', { class: 'row end' },
      h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }),
      h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' }))));
}

// ---------- Importar extractos ----------
let xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoading ||= new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = './vendor/xlsx.full.min.js';
    sc.onload = () => res(window.XLSX);
    sc.onerror = () => { xlsxLoading = null; rej(new Error('No se pudo cargar el lector de Excel (¿sin conexión la primera vez?).')); };
    document.head.append(sc);
  });
  return xlsxLoading;
}

async function readStatement(file) {
  const buf = await file.arrayBuffer();
  if (/\.(xlsx|xls|xlsm|ods)$/i.test(file.name)) {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    let best = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })
        .map((r) => r.map((c) => (typeof c === 'string' ? c.trim() : c)))
        .filter((r) => r.some((c) => c !== ''));
      if (rows.length > best.length) best = rows;
    }
    return best;
  }
  return parseCSV(decodeBytes(buf));
}

const colLetter = (i) => String.fromCharCode(65 + (i % 26));
const headSig = (rows, i) => (rows[i] || []).map((c) => String(c).toLowerCase().trim()).join('|');

function openImport(preset = {}) {
  const d = ui.data;
  const accs = d.accounts.filter((a) => !a.archived);
  if (!accs.length) { setStatus('Primero crea una cuenta.', 'warn'); return; }
  const st = { accountId: preset.accountId || (accs.some((a) => a.id === ui.filterAccount) ? ui.filterAccount : accs[0].id) };
  const err = h('p', { class: 'error', hidden: true });
  const fileIn = h('input', { type: 'file', accept: '.csv,.txt,.xlsx,.xls,.xlsm,.ods,text/csv', 'aria-label': 'Archivo del extracto' });
  const accSel = h('select', { name: 'accountId', onchange: (e) => { st.accountId = e.target.value; } }, accs.map((a) => opt(a.id, `${a.name} (${a.currency})`, a.id === st.accountId)));
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    err.hidden = true;
    try {
      const rows = await readStatement(f);
      if (rows.length < 2) throw new Error('El archivo no tiene filas para importar.');
      st.rows = rows;
      st.fileName = f.name;
      const prof = d.importProfiles.get(st.accountId);
      const useProf = !!(prof && prof.map && headSig(rows, prof.map.headerRow) === prof.sig);
      st.map = useProf ? { ...prof.map } : guessMapping(rows);
      st.fromProfile = useProf;
      importMapping(st);
    } catch (e) {
      err.textContent = e.message || String(e);
      err.hidden = false;
    }
  });
  openSheet(h('div', { class: 'form' },
    h('h3', { text: 'Importar extracto' }),
    h('p', { class: 'hint', text: 'Descarga los movimientos desde la app o la página de tu banco en CSV o Excel (.xlsx o .xls). El archivo se lee solo en este dispositivo: no se sube a ningún lado.' }),
    h('label', {}, 'Cuenta a la que pertenece el extracto', accSel),
    h('label', {}, 'Archivo', fileIn),
    err,
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }))));
}

function importMapping(st) {
  const d = ui.data;
  const acc = d.accById.get(st.accountId);
  const cur = acc.currency;
  const rows = st.rows;
  const m = st.map;
  const head = rows[m.headerRow] || [];
  const width = Math.max(...rows.slice(m.headerRow, m.headerRow + 10).map((r) => r.length));
  const colOpts = (cur0, allowNone) => [
    allowNone && opt('-1', '(ninguna)', cur0 < 0),
    ...Array.from({ length: width }, (_, i) => opt(String(i), `${colLetter(i)} · ${String(head[i] ?? '').slice(0, 28) || 'sin título'}`, i === cur0)),
  ];
  const set = (k, v) => { m[k] = v; importMapping(st); };
  const seg = (opts, curv, onpick) => h('div', { class: 'seg', style: `grid-template-columns:repeat(${opts.length},1fr)` },
    opts.map(([k, label]) => h('button', { type: 'button', class: k === curv ? 'on' : '', text: label, onclick: () => onpick(k) })));
  const preview = buildRows(rows, m, cur).slice(0, 4);
  const table = h('div', { class: 'imp-table' }, h('table', {},
    h('tbody', {}, rows.slice(m.headerRow, m.headerRow + 5).map((r, ri) => h('tr', { class: ri === 0 ? 'head' : '' },
      Array.from({ length: width }, (_, i) => h(ri === 0 ? 'th' : 'td', { text: String(r[i] ?? '').slice(0, 24) })))))));
  openSheet(h('div', { class: 'form' },
    h('h3', { text: `Columnas de ${st.fileName}` }),
    h('p', { class: 'hint', text: st.fromProfile ? `Usé las mismas columnas de la última vez para ${acc.name}. Revisa que la vista previa esté bien.` : 'Adiviné las columnas; corrige lo que haga falta mirando la vista previa de abajo.' }),
    table,
    h('label', {}, 'Fila con los títulos',
      h('select', { onchange: (e) => { st.map = { ...guessMapping(rows, Number(e.target.value)) }; importMapping(st); } },
        rows.slice(0, 15).map((r, i) => opt(String(i), `Fila ${i + 1}: ${r.filter((c) => c !== '').join(' · ').slice(0, 40)}`, i === m.headerRow)))),
    h('label', {}, 'Fecha', h('select', { onchange: (e) => set('date', Number(e.target.value)) }, colOpts(m.date))),
    h('label', {}, 'Formato de fecha', h('select', { onchange: (e) => set('dateOrder', e.target.value) },
      opt('dmy', 'Día/mes/año (31/12/2026)', m.dateOrder === 'dmy'), opt('mdy', 'Mes/día/año (12/31/2026)', m.dateOrder === 'mdy'))),
    h('label', {}, 'Descripción', h('select', { onchange: (e) => set('desc', Number(e.target.value)) }, colOpts(m.desc, true))),
    h('div', { class: 'section-title', text: 'Montos' }),
    seg([['single', 'Una columna'], ['split', 'Cargos y abonos']], m.mode, (k) => set('mode', k)),
    m.mode === 'single'
      ? [h('label', {}, 'Columna del monto', h('select', { onchange: (e) => set('amount', Number(e.target.value)) }, colOpts(m.amount))),
         h('div', { class: 'section-title', text: 'Los gastos aparecen como' }),
         seg([['neg', 'Negativos (−)'], ['pos', 'Positivos']], m.sign, (k) => set('sign', k))]
      : [h('label', {}, 'Columna de cargos (gastos)', h('select', { onchange: (e) => set('debit', Number(e.target.value)) }, colOpts(m.debit))),
         h('label', {}, 'Columna de abonos (ingresos)', h('select', { onchange: (e) => set('credit', Number(e.target.value)) }, colOpts(m.credit)))],
    h('div', { class: 'section-title', text: 'Así se va a leer' }),
    preview.length
      ? h('div', { class: 'list' }, preview.map((r) => h('div', { class: 'item' },
          h('div', { class: 'main' }, h('div', { class: 'title', text: r.desc || '(sin descripción)' }), h('div', { class: 'sub', text: shortDate(r.date) })),
          h('div', { class: 'amt ' + (r.kind === 'gasto' ? 'neg' : 'pos'), text: (r.kind === 'gasto' ? '−' : '+') + formatMoney(r.amount, cur) }))))
      : h('p', { class: 'error', text: 'Con estas columnas no se reconoce ninguna fila: revisa la fecha y el monto.' }),
    h('div', { class: 'row between wrap' },
      h('button', { class: 'btn', type: 'button', text: '‹ Otro archivo', onclick: () => openImport({ accountId: st.accountId }) }),
      h('button', { class: 'btn primary', type: 'button', text: 'Continuar', disabled: !preview.length, onclick: () => importReview(st) }))));
}

function importReview(st) {
  const d = ui.data;
  const acc = d.accById.get(st.accountId);
  const cur = acc.currency;
  const built = markDuplicates(buildRows(st.rows, st.map, cur), d.realMovs, acc.id);
  const catOk = (id, kind) => { const c = d.catById.get(id); return c && c.kind === kind && !c.archived; };
  st.items = built.map((r, i) => {
    const rule = ruleFor(r.desc, d.rules);
    return { ...r, i, key: merchantKey(r.desc), include: !r.duplicate && !r.maybeTransfer, categoryId: rule && catOk(rule.categoryId, r.kind) ? rule.categoryId : '', manual: false };
  });
  const dups = st.items.filter((r) => r.duplicate).length;
  const transf = st.items.filter((r) => r.maybeTransfer && !r.duplicate).length;
  const dates = st.items.map((r) => r.date).sort();
  const countEl = h('strong');
  const goBtn = h('button', { class: 'btn primary', type: 'button' });
  const refresh = () => {
    const n = st.items.filter((r) => r.include).length;
    countEl.textContent = `${n} de ${st.items.length} seleccionados`;
    goBtn.textContent = `Importar ${n}`;
    goBtn.disabled = !n;
  };
  const catSelect = (r) => h('select', { 'data-key': r.key, 'data-kind': r.kind, 'aria-label': 'Categoría', onchange: (e) => {
    r.categoryId = e.target.value;
    r.manual = true;
    // El mismo comercio en otras filas toma la misma categoría (si no la cambiaste a mano).
    if (r.key) for (const o of st.items) if (o !== r && !o.manual && o.key === r.key && o.kind === r.kind) {
      o.categoryId = r.categoryId;
      const sel = list.querySelector(`select[data-row="${o.i}"]`);
      if (sel) sel.value = o.categoryId;
    }
  } }, opt('', 'Sin categoría', !r.categoryId), d.cats.filter((c) => c.kind === r.kind && !c.archived).map((c) => opt(c.id, c.name, c.id === r.categoryId)));
  const rowEl = (r) => {
    const sel = catSelect(r);
    sel.setAttribute('data-row', String(r.i));
    const box = h('input', { type: 'checkbox', checked: r.include, 'aria-label': `Importar ${r.desc}`, onchange: (e) => { r.include = e.target.checked; refresh(); } });
    const kindSel = h('select', { 'aria-label': 'Tipo', onchange: (e) => {
      r.kind = e.target.value;
      r.categoryId = '';
      r.manual = false;
      const fresh = rowEl(r);
      wrap.replaceWith(fresh);
    } }, opt('gasto', 'Gasto', r.kind === 'gasto'), opt('ingreso', 'Ingreso', r.kind === 'ingreso'));
    const wrap = h('div', { class: 'imp-row' + (r.duplicate ? ' dup' : '') },
      h('label', { class: 'imp-check' }, box),
      h('div', { class: 'imp-main' },
        h('div', { class: 'row between' },
          h('span', { class: 'title', text: r.desc || '(sin descripción)' }),
          h('span', { class: 'amt ' + (r.kind === 'gasto' ? 'neg' : 'pos'), text: (r.kind === 'gasto' ? '−' : '+') + formatMoney(r.amount, cur) })),
        h('div', { class: 'sub' }, shortDate(r.date),
          r.duplicate && h('span', { class: 'tag', text: 'Ya registrado' }),
          r.maybeTransfer && h('span', { class: 'tag', text: '¿Pago o transferencia?' })),
        h('div', { class: 'imp-sel' }, kindSel, sel)));
    return wrap;
  };
  const list = h('div', { class: 'imp-list' }, st.items.map(rowEl));
  refresh();
  goBtn.onclick = () => doImport(st);
  openSheet(h('div', { class: 'form' },
    h('h3', { text: `Revisar ${st.items.length} movimientos` }),
    h('p', { class: 'hint', text: `${acc.name} · del ${shortDate(dates[0])} al ${shortDate(dates.at(-1))}.` +
      (dups ? ` ${dups} ya estaban registrados y quedaron sin marcar.` : '') +
      (transf ? ` ${transf} parecen pagos o transferencias entre tus cuentas: quedaron sin marcar para que no se dupliquen (márcalos si de verdad son gastos o ingresos).` : '') +
      ' La categoría que elijas para un comercio se aplica a sus otras filas y se recuerda para la próxima vez.' }),
    list,
    h('div', { class: 'selbar' }, countEl, h('span', { style: 'flex:1' }),
      h('button', { class: 'btn', type: 'button', text: '‹ Columnas', onclick: () => importMapping(st) }), goBtn)));
}

async function doImport(st) {
  const d = ui.data;
  const acc = d.accById.get(st.accountId);
  const importId = 'imp-' + crypto.randomUUID().slice(0, 8);
  const now = Date.now();
  const chosen = st.items.filter((r) => r.include);
  const recs = chosen.map((r, k) => ({
    col: 'movs', id: crypto.randomUUID(), kind: r.kind, date: r.date, accountId: acc.id, amount: r.amount,
    categoryId: r.categoryId, note: r.desc.slice(0, 120), createdAt: now + k, deleted: false, importId,
  }));
  // Reglas aprendidas: cada comercio al que le pusiste categoría a mano.
  const rules = new Map();
  for (const r of st.items) if (r.manual && r.categoryId && r.key && r.key.length >= 3) rules.set(r.key, r.categoryId);
  const ruleRecs = [...rules].map(([pattern, categoryId]) => ({ col: 'reglas', id: 'r-' + pattern.replace(/\s+/g, '-').slice(0, 60), pattern, categoryId, deleted: false }));
  const prof = { col: 'config', id: 'import-' + acc.id, map: st.map, sig: headSig(st.rows, st.map.headerRow), deleted: false };
  closeSheet();
  await saveRecords([...recs, ...ruleRecs, prof]);
  const dates = chosen.map((r) => r.date).sort();
  openSheet(h('div', { class: 'form' },
    h('h3', { text: 'Importación lista' }),
    h('p', { text: `Se agregaron ${recs.length} movimientos a ${acc.name}${ruleRecs.length ? ` y se guardaron ${ruleRecs.length} regla(s) de categoría` : ''}.` }),
    h('div', { class: 'row between wrap' },
      h('button', { class: 'btn danger', type: 'button', text: 'Deshacer importación', onclick: async () => {
        const mine = (await store.getAllRecords()).filter((r) => r.col === 'movs' && r.importId === importId && !r.deleted);
        closeSheet();
        await saveRecords(mine.map((r) => ({ ...r, deleted: true, trash: importId })));
        setStatus(`Importación deshecha: ${mine.length} movimientos quitados (quedan en la Papelera).`, 'ok');
      } }),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', text: 'Ver en Movimientos', onclick: () => {
          closeSheet();
          Object.assign(ui, { q: '', fKind: '', fCat: '', filterAccount: acc.id, period: 'rango', from: dates[0] || '', to: dates.at(-1) || '', showFilters: true });
          showTab('movs');
        } }),
        h('button', { class: 'btn primary', type: 'button', text: 'Cerrar', onclick: closeSheet })))));
}

function renderRules(d) {
  const root = $('#rules-box');
  if (!root) return;
  if (!d.rules.length) { root.replaceChildren(h('p', { class: 'hint', text: 'Aún no hay reglas. Se crean solas cuando eliges la categoría de un comercio al importar un extracto.' })); return; }
  root.replaceChildren(h('div', { class: 'list' }, [...d.rules].sort((a, b) => a.pattern.localeCompare(b.pattern)).map((r) => {
    const c = d.catById.get(r.categoryId);
    return h('div', { class: 'item' },
      h('div', { class: 'main' }, h('div', { class: 'title', text: `«${r.pattern}»` }), h('div', { class: 'sub', text: `→ ${c ? c.name : 'categoría eliminada'}` })),
      h('button', { class: 'btn', type: 'button', text: 'Quitar', onclick: () => saveRecord({ ...r, deleted: true }) }));
  })));
}

// ---------- Papelera ----------
function trashLabel(r, d) {
  const acc = d.allAccounts.get(r.accountId);
  const cur = r.currency || (acc ? acc.currency : 'COP');
  if (r.col === 'cuentas') return `Cuenta «${r.name}»`;
  if (r.col === 'deudas') return `${r.dir === 'debo' ? 'Le debes a' : 'Te debe'} ${r.person}: ${formatMoney(r.amount, r.currency)}`;
  if (r.col === 'metas') { const a = d.allAccounts.get(r.accountId); return `Meta de ahorro «${(r.name && r.name.trim()) || (a ? a.name : 'cajita')}»`; }
  if (r.col === 'inv') return `${r.kind === 'compra' ? 'Compra' : r.kind === 'venta' ? 'Venta' : 'Dividendo'} ${r.symbol} · ${formatMoney(r.amount, cur)}`;
  const kind = r.kind === 'gasto' ? 'Gasto' : r.kind === 'ingreso' ? 'Ingreso' : 'Transferencia';
  const cat = r.categoryId && d.catById.get(r.categoryId);
  return `${kind} ${formatMoney(r.amount, cur)}${r.note ? ' · ' + r.note : cat ? ' · ' + cat.name : ''} · ${shortDate(r.date)}`;
}

async function restoreTrash(g) {
  const all = await store.getAllRecords();
  const relink = g.main.col === 'cuentas'
    ? all.filter((r) => !r.deleted && r.trash === g.key && r.prevAccountId === g.main.id && !r.accountId).map((r) => ({ ...r, accountId: r.prevAccountId, prevAccountId: undefined, trash: undefined }))
    : [];
  await saveRecords([...g.items.map((r) => ({ ...r, deleted: false, trash: undefined })), ...relink]);
}

function openTrash() {
  const d = ui.data;
  const list = d.trash;
  openSheet(h('div', { class: 'form' },
    h('h3', { text: 'Papelera' }),
    h('p', { class: 'hint', text: `Lo que eliminas se puede recuperar durante ${TRASH_DAYS} días; después se borra del todo.` }),
    list.length
      ? h('div', { class: 'list' }, list.map((g) => {
          const extra = g.items.length - 1;
          return h('div', { class: 'item' },
            h('div', { class: 'main' },
              h('div', { class: 'title', text: trashLabel(g.main, d) }),
              h('div', { class: 'sub', text: `Eliminado ${timeAgo(g.deletedAt)}${extra > 0 ? ` · junto con ${extra} registro(s) más` : ''}` })),
            h('button', { class: 'btn', type: 'button', text: 'Recuperar', onclick: async () => { await restoreTrash(g); openTrash(); } }));
        }))
      : h('p', { class: 'hint', text: 'La papelera está vacía.' }),
    h('div', { class: 'row between wrap' },
      list.length ? h('button', { class: 'btn danger', type: 'button', text: 'Vaciar papelera', onclick: async () => {
        if (!confirm('¿Borrar del todo lo que hay en la papelera? No se podrá recuperar (salvo restaurando una versión anterior).')) return;
        await purgeTrash(true);
        openTrash();
      } }) : h('span'),
      h('button', { class: 'btn', type: 'button', text: 'Cerrar', onclick: closeSheet }))));
}

// ---------- Versiones anteriores ----------
const fmtStamp = (iso) => new Intl.DateTimeFormat('es-CO', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

async function openVersions() {
  if (!isConfigured()) { setStatus('Configura primero la sincronización.', 'warn'); return; }
  const gh = makeGh();
  const box = h('div', { class: 'list' });
  const more = h('button', { class: 'btn', type: 'button', text: 'Ver más antiguas', hidden: true });
  const msg = h('p', { class: 'hint', text: 'Cargando versiones…' });
  let page = 1;
  async function load() {
    more.disabled = true;
    try {
      const list = await gh.listVersions(page);
      msg.textContent = page === 1 && !list.length ? 'Todavía no hay versiones guardadas.' : 'Cada sincronización guarda una versión. Se conservan todas las de los últimos 2 días y una por día hasta 90 días.';
      for (const v of list) {
        box.append(h('button', { type: 'button', class: 'item', onclick: () => openVersion(gh, v) },
          h('div', { class: 'main' }, h('div', { class: 'title', text: fmtStamp(v.date) }), h('div', { class: 'sub', text: timeAgo(Date.parse(v.date)) })),
          h('div', { class: 'amt', text: 'Ver ›' })));
      }
      more.hidden = list.length < 100;
      page += 1;
    } catch (e) {
      msg.textContent = errorMessage(e);
    } finally {
      more.disabled = false;
    }
  }
  more.onclick = load;
  openSheet(h('div', { class: 'form' }, h('h3', { text: 'Versiones anteriores' }), msg, box, more,
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', text: 'Cerrar', onclick: closeSheet }))));
  load();
}

async function keyFor(file) {
  const cached = await store.getMeta('syncKey');
  if (cached && cached.salt === file.salt && cached.iter === file.iter) return cached.key;
  const p = await askPassphrase({ isNew: false });
  if (!p) throw new SyncError('CANCELLED');
  return deriveKey(p, file.salt, file.iter);
}

async function openVersion(gh, v) {
  const body = h('div', { class: 'form' }, h('h3', { text: fmtStamp(v.date) }), h('p', { class: 'hint', text: 'Descargando y descifrando…' }));
  openSheet(body);
  let records;
  try {
    const got = await gh.get(v.sha);
    const file = JSON.parse(got.text);
    records = (await decryptJson(await keyFor(file), file)).records || [];
  } catch (e) {
    if (e.code === 'CANCELLED') return openVersions();
    body.replaceChildren(h('h3', { text: fmtStamp(v.date) }), h('p', { class: 'error', text: errorMessage(e) }),
      h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', text: 'Volver', onclick: openVersions })));
    return;
  }
  const then = versionSummary(records);
  const now = versionSummary(await store.getAllRecords());
  const row = (label, k) => h('div', { class: 'line' }, h('span', { text: label }),
    h('span', { text: `${then[k]}${then[k] !== now[k] ? `  (hoy ${now[k]})` : ''}` }));
  body.replaceChildren(
    h('h3', { text: fmtStamp(v.date) }),
    h('div', { class: 'card' },
      row('Movimientos', 'movs'), row('Cuentas', 'cuentas'), row('Deudas', 'deudas'), row('Operaciones de inversión', 'inv'), row('Metas de ahorro', 'metas')),
    h('p', { class: 'hint', text: 'Restaurar deja tus datos exactamente como estaban en esta versión, en todos tus dispositivos. Lo de hoy no se pierde: queda como otra versión en esta misma lista, por si quieres volver.' }),
    h('div', { class: 'row between wrap' },
      h('button', { class: 'btn', type: 'button', text: '‹ Volver', onclick: openVersions }),
      h('button', { class: 'btn primary', type: 'button', text: 'Restaurar esta versión', onclick: async () => {
        if (!confirm(`¿Dejar tus datos como estaban el ${fmtStamp(v.date)}?`)) return;
        closeSheet();
        await doSync(false); // primero se guarda lo de hoy como versión
        await saveRecords(restorePlan(await store.getAllRecords(), records));
        setStatus(`Datos restaurados a la versión del ${fmtStamp(v.date)}.`, 'ok');
      } })));
}

function renderHistoryBox() {
  const root = $('#history-box');
  if (!root) return;
  const d = ui.data;
  const c = d.compactRec;
  const size = h('span', { class: 'hint', text: '' });
  const note = h('strong', { text: ui.histMsg || '' });
  root.replaceChildren(
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', type: 'button', text: `Papelera (${d.trash.length})`, onclick: openTrash }),
      h('button', { class: 'btn', type: 'button', text: 'Versiones anteriores', onclick: openVersions })),
    h('p', { class: 'hint', style: 'margin-top:10px' },
      c ? `Última limpieza del historial ${timeAgo(c.at)} (${c.before} → ${c.after} versiones). ` : 'El historial se limpia solo cada 30 días. ',
      note,
      size,
      isConfigured() && h('button', { class: 'link-btn', type: 'button', text: 'Limpiar ahora', onclick: async (ev) => {
        ev.target.disabled = true;
        note.textContent = 'Limpiando… ';
        try {
          const r = await maybeCompact(makeGh(), true);
          ui.histMsg = r && r.raced ? 'Otro dispositivo estaba subiendo cambios; intenta de nuevo. '
            : r && r.changed ? `Listo: ${r.before} → ${r.after} versiones. ` : 'No había versiones viejas que limpiar. ';
        } catch (e) {
          ui.histMsg = errorMessage(e) + ' ';
        }
        await render();
        setTimeout(() => { ui.histMsg = ''; }, 0);
      } })));
  if (isConfigured()) {
    makeGh().repoSizeKB().then((kb) => {
      if (size.textContent) return;
      size.textContent = `Tamaño del repositorio de datos: ${kb < 1024 ? kb + ' KB' : (kb / 1024).toFixed(1).replace('.', ',') + ' MB'}. `;
    }).catch(() => {});
  }
}

// ---------- Inversiones ----------
const getPxKey = () => { try { return localStorage.getItem(PX_KEY) || ''; } catch { return ''; } };
const fmtQty = (q) => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 8 }).format(q);
const signedMoney = (v, cur) => (v > 0 ? '+' : v < 0 ? '−' : '') + formatMoney(Math.abs(v), cur);
const pctTxt = (p) => (p === null || p === undefined ? '' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${(Math.abs(p) * 100).toFixed(1).replace('.', ',')}%`);
const gainText = (u, pct, cur) => `${u > 0 ? '▲ ' : u < 0 ? '▼ ' : ''}${signedMoney(u, cur)}${pct === null || pct === undefined ? '' : ` (${pctTxt(pct)})`}`;
const toneOf = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
// Precio por acción escrito como "200.99" o "200,9912": hasta 4 decimales (parseAmount solo admite 2).
const parsePrice = (text, cur) => {
  const q = parseQty(text);
  return q ? Math.round(q * 10 ** dec(cur)) : null;
};


const fmtRate = (r) => `$ ${new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(r)}`;
const pctPlain = (x) => `${(x * 100).toFixed(1).replace('.', ',')}%`;
// TRM escrita a mano: "3.950,50", "3950.5", "3.950" (un punto + 3 dígitos = miles).
function parseRate(text) {
  const t = String(text || '').trim().replace(/[^\d.,]/g, '');
  if (!/\d/.test(t)) return null;
  let v;
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) v = Number(t.replace(/[.,]/g, ''));
  else {
    const last = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
    v = last < 0 ? Number(t) : Number(`${t.slice(0, last).replace(/[.,]/g, '')}.${t.slice(last + 1)}`);
  }
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Ganancia en pesos y real (descontando inflación). c: { valueCop, costCop, adj|null }
function copBlock(c, { fxAvg, onInfl } = {}) {
  const gain = c.valueCop - c.costCop;
  const pct = c.costCop > 0 ? gain / c.costCop : null;
  const cop = (v) => formatMoney(Math.round(v), 'COP');
  const line = (a, b, cls) => h('div', { class: 'line' }, h('span', { text: a }), h('span', { class: cls || '', text: b }));
  const out = [
    h('div', { class: 'cop-title', text: 'En pesos' }),
    fxAvg && line('Dólar promedio de tus compras', fmtRate(fxAvg)),
    line('Valor hoy', cop(c.valueCop)),
    line('Lo que pagaste', cop(c.costCop)),
    line('Ganancia en pesos', `${gain > 0 ? '▲ ' : gain < 0 ? '▼ ' : ''}${signedMoney(Math.round(gain), 'COP')}${pct === null ? '' : ` (${pctTxt(pct)})`}`, toneOf(gain)),
  ];
  if (c.adj === null) {
    out.push(h('button', { class: 'btn', type: 'button', style: 'margin-top:6px', text: 'Definir inflación para ver la ganancia real', onclick: onInfl }));
  } else {
    const real = c.valueCop - c.adj;
    const realPct = c.adj > 0 ? real / c.adj : null;
    out.push(
      line('Inflación del periodo (aprox.)', c.costCop > 0 ? pctPlain(c.adj / c.costCop - 1) : '—'),
      line('Ganancia real (sin inflación)', `${real > 0 ? '▲ ' : real < 0 ? '▼ ' : ''}${signedMoney(Math.round(real), 'COP')}${realPct === null ? '' : ` (${pctTxt(realPct)})`}`, toneOf(real)),
      h('p', { class: 'hint cop-verdict', style: 'margin:6px 0 0', text: real > 0 ? '✓ Estás ganando poder adquisitivo: tu plata crece más que la inflación.' : '⚠ Por ahora no le ganas a la inflación: en pesos reales vas en pérdida.' }));
  }
  return out;
}

async function refreshFx(manual) {
  const d = ui.data;
  if (!d || ui.fxBusy || !d.inv.rows.some((r) => r.currency === 'USD')) return;
  ui.lastFxTry = Date.now();
  ui.fxBusy = true;
  const r = await fetchTrm(todayStr());
  ui.fxBusy = false;
  if (r.rate) {
    ui.fxMsg = '';
    const cur = d.fx;
    const fresh = cur && cur.source === 'api' && cur.price === r.rate && Date.now() - cur.asOf < 6 * 3600e3;
    if (!fresh) { await saveRecord({ col: 'precios', id: 'fx-USDCOP', symbol: 'USDCOP', price: r.rate, asOf: Date.now(), source: 'api', deleted: false }); return; }
  } else ui.fxMsg = r.error;
  if (ui.tab === 'inv') await render();
}

// Busca la TRM de cada compra en USD que no la tiene (una consulta por fecha distinta).
async function fillMissingFx() {
  const d = ui.data;
  const todo = d.ops.filter((o) => o.kind === 'compra' && o.currency === 'USD' && !(o.fx > 0));
  if (!todo.length || ui.fxBusy) return;
  ui.fxBusy = true;
  ui.fxMsg = `Buscando la TRM de ${todo.length} compra(s)…`;
  await render();
  const byDate = new Map();
  const recs = [];
  let failed = '';
  for (const o of todo) {
    if (!byDate.has(o.date)) byDate.set(o.date, await fetchTrm(o.date));
    const r = byDate.get(o.date);
    if (r.rate) recs.push({ ...o, fx: r.rate });
    else { failed = r.error; if (/conexi|bloque/.test(r.error)) break; }
  }
  ui.fxBusy = false;
  ui.fxMsg = failed ? `${recs.length ? `Completadas ${recs.length}. ` : ''}${failed}` : '';
  if (recs.length) await saveRecords(recs);
  else await render();
}

function openFxForm() {
  const d = ui.data;
  const err = h('p', { class: 'error', hidden: true });
  openSheet(h('form', { class: 'form', onsubmit: async (ev) => {
    ev.preventDefault();
    const v = parseRate(ev.target.elements.fx.value);
    if (!v) { err.textContent = 'Escribe cuántos pesos vale un dólar hoy.'; err.hidden = false; return; }
    closeSheet();
    await saveRecord({ col: 'precios', id: 'fx-USDCOP', symbol: 'USDCOP', price: v, asOf: Date.now(), source: 'manual', deleted: false });
  } },
    h('h3', { text: 'Dólar de hoy' }),
    h('p', { class: 'hint', text: 'Normalmente se trae solo (TRM oficial). Escríbelo si no hay conexión o quieres usar otra tasa.' }),
    h('label', {}, 'Pesos por dólar',
      h('input', { type: 'text', name: 'fx', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Ej: 3.950,50', value: d.fx ? String(d.fx.price) : '' })),
    err,
    h('div', { class: 'row end' },
      h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }),
      h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' }))));
}

function openInflForm() {
  const d = ui.data;
  const err = h('p', { class: 'error', hidden: true });
  const cur = d.infl && d.infl.annual !== null && d.infl.annual !== undefined ? String((d.infl.annual * 100).toFixed(2)).replace(/\.?0+$/, '').replace('.', ',') : '';
  openSheet(h('form', { class: 'form', onsubmit: async (ev) => {
    ev.preventDefault();
    const raw = ev.target.elements.pct.value.trim();
    const v = raw ? parseQty(raw) : null;
    if (raw && (v === null || v < 0 || v > 200)) { err.textContent = 'Escribe un porcentaje, por ejemplo 5,2.'; err.hidden = false; return; }
    closeSheet();
    await saveRecord({ col: 'config', id: 'inflacion', annual: raw ? v / 100 : null, deleted: false });
  } },
    h('h3', { text: 'Inflación anual' }),
    h('p', { class: 'hint', text: 'Usa la inflación anual de Colombia (IPC) que publica el DANE; la app la aplica a cada compra según los días que lleva. Es una aproximación: la inflación real cambia mes a mes.' }),
    h('label', {}, 'Inflación anual (%)',
      h('input', { type: 'text', name: 'pct', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Ej: 5,2', value: cur })),
    err,
    h('div', { class: 'row end' },
      h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }),
      h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' }))));
}

function fxInflCard(d) {
  const ago = d.fx ? timeAgo(d.fx.asOf) : '';
  return h('div', { class: 'chart-card' },
    h('h3', { text: 'Dólar e inflación' }),
    h('div', { class: 'list' },
      h('button', { type: 'button', class: 'item', onclick: openFxForm },
        h('div', { class: 'main' }, h('div', { class: 'title', text: 'Dólar hoy (TRM)' }),
          h('div', { class: 'sub', text: d.fx ? `${d.fx.source === 'api' ? 'Oficial' : 'Escrito a mano'} · ${ago} · toca para corregir` : 'Sin dato · toca para escribirlo' })),
        h('div', { class: 'amt', text: d.fx ? fmtRate(d.fx.price) : '—' })),
      h('button', { type: 'button', class: 'item', onclick: openInflForm },
        h('div', { class: 'main' }, h('div', { class: 'title', text: 'Inflación anual (aprox.)' }),
          h('div', { class: 'sub', text: 'Se descuenta de tus ganancias en pesos' })),
        h('div', { class: 'amt', text: d.infl && d.infl.annual !== null && d.infl.annual !== undefined ? pctPlain(d.infl.annual) : 'Definir' }))),
    ui.fxMsg && h('p', { class: 'hint', style: 'margin:8px 0 0', text: ui.fxMsg }));
}

function positionRow(r) {
  const cur = r.currency;
  const price = r.hasPrice ? ` · Precio ${formatMoney(Math.round(r.price), cur)}` : ' · sin precio (a costo)';
  return h('button', { type: 'button', class: 'item', onclick: () => openPositionDetail(r.symbol) },
    h('div', { class: 'main' },
      h('div', { class: 'title', text: r.symbol }),
      h('div', { class: 'sub', text: `${fmtQty(r.qty)} acc. · costo prom. ${formatMoney(Math.round(r.avgCost), cur)}` }),
      h('div', { class: 'sub', text: price.replace(/^ · /, '') })),
    h('div', { class: 'amt' }, formatMoney(r.value, cur),
      h('small', { class: toneOf(r.unrealized), text: r.hasPrice ? gainText(r.unrealized, r.pct, cur) : 'sin precio' })));
}

function renderInv(d) {
  const root = $('#inv-body');
  root.replaceChildren();
  if (!d.ops.length) {
    root.append(h('div', { class: 'empty' },
      h('p', { text: 'Aquí llevas tus acciones y ETF: cuánto tienes, a qué costo promedio y cuánto ganas o pierdes.' }),
      h('p', { class: 'hint', text: 'Si ya tienes acciones, regístralas como una compra (con la fecha aproximada) y deja la cuenta en "No afecta ninguna cuenta", para no mover tu saldo.' }),
      h('button', { class: 'btn primary', type: 'button', onclick: () => openInvForm(), text: '＋ Registrar operación' })));
    return;
  }
  const { rows, totals } = d.inv;
  const open = rows.filter((r) => r.open);
  const closed = rows.filter((r) => !r.open);
  const latest = Math.max(0, ...open.filter((r) => r.hasPrice).map((r) => r.priceAt || 0));
  root.append(h('div', { class: 'pxbar' },
    h('p', { class: 'hint', text: ui.pxMsg || (latest ? `Precios de ${timeAgo(latest)}.` : 'Sin precios todavía: se valora al costo.') }),
    h('button', { class: 'btn', type: 'button', text: '⟳ Actualizar precios', disabled: ui.pxBusy, onclick: async () => { await refreshFx(true); await refreshPrices(true); } })));

  const cards = h('div', { class: 'cards' });
  for (const [cur, t] of Object.entries(totals)) {
    const pct = t.cost > 0 ? t.unrealized / t.cost : null;
    cards.append(h('div', { class: 'card' },
      h('div', { class: 'cur', text: `Inversiones · ${CURRENCIES[cur] ? CURRENCIES[cur].label : cur}` }),
      h('div', { class: 'big', text: formatMoney(t.value, cur) }),
      h('div', { class: 'line' }, h('span', { text: 'Costo' }), h('span', { text: formatMoney(t.cost, cur) })),
      h('div', { class: 'line' }, h('span', { text: 'Ganancia sin vender' }), h('span', { class: toneOf(t.unrealized), text: gainText(t.unrealized, pct, cur) })),
      t.realized !== 0 && h('div', { class: 'line' }, h('span', { text: 'Ganancia realizada' }), h('span', { class: toneOf(t.realized), text: signedMoney(t.realized, cur) })),
      t.dividends !== 0 && h('div', { class: 'line' }, h('span', { text: 'Dividendos' }), h('span', { text: formatMoney(t.dividends, cur) })),
      t.missing > 0 && h('p', { class: 'hint', style: 'margin:6px 0 0', text: `${t.missing} posición(es) sin precio: se cuentan al costo.` }),
      cur === 'USD' && t.cop && copBlock({ valueCop: t.cop.valueCop, costCop: t.cop.costCop, adj: t.cop.hasAdj ? t.cop.adj : null }, { onInfl: openInflForm }),
      cur === 'USD' && t.copMissing > 0 && h('div', {},
        h('p', { class: 'hint', style: 'margin:8px 0 4px', text: `Faltan el dólar de ${t.copMissing} compra(s) para calcular tu ganancia en pesos.` }),
        h('button', { class: 'btn', type: 'button', text: 'Buscar TRM faltantes', disabled: ui.fxBusy, onclick: fillMissingFx })),
      cur === 'USD' && !d.fx && h('p', { class: 'hint', style: 'margin:8px 0 0', text: 'Sin el dólar de hoy no se puede calcular en pesos. Usa "Actualizar precios" o escríbelo abajo.' })));
  }
  root.append(cards);
  if (totals.USD) root.append(fxInflCard(d));

  if (open.length) root.append(h('div', { class: 'section-title', text: 'Posiciones' }), h('div', { class: 'list' }, open.map(positionRow)));

  for (const cur of Object.keys(totals)) {
    const list = open.filter((r) => r.currency === cur);
    const total = list.reduce((a, r) => a + r.value, 0);
    if (list.length < 2 || total <= 0) continue;
    root.append(h('div', { class: 'chart-card' }, h('h3', { text: `Distribución · ${cur}` }),
      h('p', { class: 'hint', text: 'Cuánto pesa cada posición en tu portafolio' }),
      rankedBars(list.map((r) => ({ label: r.symbol, value: r.value, share: r.value / total })), cur, 'del portafolio')));
  }

  const hiddenSec = getView().hiddenSections;
  if (totals.USD && !hiddenSec.includes('inv-bench')) renderBenchmark(root, d);
  if (totals.USD && !hiddenSec.includes('inv-alloc')) renderAllocation(root, d);

  if (closed.length) {
    root.append(h('div', { class: 'section-title', text: 'Cerradas' }), h('div', { class: 'list' }, closed.map((r) =>
      h('button', { type: 'button', class: 'item done', onclick: () => openPositionDetail(r.symbol) },
        h('div', { class: 'main' }, h('div', { class: 'title', text: r.symbol }), h('div', { class: 'sub', text: 'Vendida por completo' })),
        h('div', { class: 'amt ' + toneOf(r.realized), text: signedMoney(r.realized, r.currency) })))));
  }
  root.append(h('div', { class: 'row wrap', style: 'margin-top:14px' },
    h('button', { class: 'btn', type: 'button', onclick: () => openInvForm(), text: '＋ Nueva operación' })));
}

async function refreshPrices(manual) {
  const d = ui.data;
  if (!d || ui.pxBusy) return;
  const syms = d.inv.rows.filter((r) => r.open && r.currency === 'USD').map((r) => r.symbol);
  const key = getPxKey();
  if (!syms.length) {
    if (manual) { ui.pxMsg = 'No hay posiciones en USD para actualizar.'; await render(); }
    return;
  }
  if (!key) {
    if (manual) {
      openSheet(h('div', { class: 'form' },
        h('h3', { text: 'Precios automáticos' }),
        h('p', { class: 'hint', text: 'Para traer precios solos necesitas una clave gratis de Twelve Data (en Ajustes se guarda). Mientras tanto puedes escribir el precio a mano: toca una posición y usa "Precio actual".' }),
        h('div', { class: 'row end wrap' },
          h('button', { class: 'btn', type: 'button', text: 'Cerrar', onclick: closeSheet }),
          h('button', { class: 'btn primary', type: 'button', text: 'Ir a Ajustes', onclick: () => { closeSheet(); showTab('ajustes'); } }))));
    }
    return;
  }
  ui.lastPxTry = Date.now();
  ui.pxBusy = true;
  ui.pxMsg = 'Consultando precios…';
  if (ui.tab === 'inv') await render();
  const res = await fetchPrices(syms, key);
  ui.pxBusy = false;
  const now = Date.now();
  const recs = Object.entries(res.prices).map(([symbol, price]) => ({ col: 'precios', id: 'px-' + symbol, symbol, price, asOf: now, source: 'api', deleted: false }));
  const problems = [];
  if (res.fatal) problems.push(res.fatal);
  for (const [s2, e] of Object.entries(res.errors)) problems.push(`${s2}: ${e}.`);
  if (res.skipped && res.skipped.length) problems.push(`Por el límite gratis no se consultaron: ${res.skipped.join(', ')}.`);
  ui.pxMsg = problems.length ? `${recs.length ? `Actualizados ${recs.length}. ` : ''}${problems.join(' ')}` : '';
  if (recs.length) await saveRecords(recs);
  else await render();
}

function openPositionDetail(symbol) {
  const d = ui.data;
  const r = d && d.inv.rows.find((x) => x.symbol === symbol);
  if (!r) { closeSheet(); return; }
  const cur = r.currency;
  const px = d.prices.get(symbol);
  const ops = d.ops.filter((o) => o.symbol === symbol)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
  const line = (a, b, cls) => h('div', { class: 'line' }, h('span', { text: a }), h('span', { class: cls || '', text: b }));
  const err = h('p', { class: 'error', hidden: true });
  async function savePrice(ev) {
    ev.preventDefault();
    const m = parsePrice(ev.target.elements.px.value, cur);
    if (!m) { err.textContent = 'Escribe un precio mayor que cero.'; err.hidden = false; return; }
    await saveRecord({ col: 'precios', id: 'px-' + symbol, symbol, price: m, asOf: Date.now(), source: 'manual', deleted: false });
    openPositionDetail(symbol);
  }
  openSheet(h('div', { class: 'form' },
    h('h3', { text: symbol }),
    h('div', { class: 'card' },
      r.open && line('Acciones', fmtQty(r.qty)),
      r.open && line('Costo total', formatMoney(r.cost, cur)),
      r.open && line('Costo promedio', formatMoney(Math.round(r.avgCost), cur)),
      r.open && line('Valor actual', formatMoney(r.value, cur) + (r.hasPrice ? '' : ' (a costo)')),
      r.open && r.hasPrice && line('Ganancia sin vender', gainText(r.unrealized, r.pct, cur), toneOf(r.unrealized)),
      line('Ganancia realizada', signedMoney(r.realized, cur), toneOf(r.realized)),
      r.dividends > 0 && line('Dividendos', formatMoney(r.dividends, cur))),
    r.open && r.cop && !r.cop.missing && h('div', { class: 'card' }, copBlock({ valueCop: r.cop.valueCop, costCop: r.cop.costCop, adj: r.cop.adj }, { fxAvg: r.cop.fxAvg, onInfl: openInflForm })),
    r.open && r.cop && r.cop.missing > 0 && h('p', { class: 'hint', text: `Faltan el dólar de ${r.cop.missing} compra(s) de esta posición. Ábrelas abajo y pon la TRM, o usa "Buscar TRM faltantes" en la pestaña.` }),
    h('form', { class: 'form', onsubmit: savePrice },
      h('label', {}, `Precio actual por acción (${cur})`,
        h('input', { type: 'text', name: 'px', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Ej: 200,99', value: px ? toInput(Math.round(px.price), cur) : '' })),
      px && h('p', { class: 'hint', style: 'margin:0', text: `${px.source === 'api' ? 'Traído automáticamente' : 'Escrito a mano'} ${timeAgo(px.asOf)}.` }),
      err,
      h('button', { class: 'btn', type: 'submit', text: 'Guardar precio' })),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', type: 'button', text: 'Comprar', onclick: () => openInvForm(null, { symbol, kind: 'compra' }) }),
      r.open && h('button', { class: 'btn', type: 'button', text: 'Vender', onclick: () => openInvForm(null, { symbol, kind: 'venta' }) }),
      h('button', { class: 'btn', type: 'button', text: 'Dividendo', onclick: () => openInvForm(null, { symbol, kind: 'dividendo' }) })),
    h('div', { class: 'section-title', text: 'Operaciones' }),
    h('div', { class: 'list' }, ops.map((o) =>
      h('button', { type: 'button', class: 'item', onclick: () => openInvForm(o) },
        h('div', { class: 'main' },
          h('div', { class: 'title', text: `${o.kind === 'compra' ? 'Compra' : o.kind === 'venta' ? 'Venta' : 'Dividendo'}${o.kind === 'dividendo' ? '' : ' · ' + fmtQty(o.qty) + ' acc.'}` }),
          h('div', { class: 'sub', text: [shortDate(o.date), o.price ? `a ${formatMoney(o.price, cur)}` : null, o.note].filter(Boolean).join(' · ') })),
        h('div', { class: 'amt ' + (o.kind === 'compra' ? 'neg' : 'pos'), text: (o.kind === 'compra' ? '−' : '+') + formatMoney(o.amount, cur) })))),
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', text: 'Cerrar', onclick: closeSheet }))));
}

async function openInvForm(existing, preset = {}) {
  const d = ui.data;
  if (!d) return;
  const lastAcc = await store.getMeta('lastInvAccount');
  const symbols = [...new Set(d.ops.map((o) => o.symbol))].sort();
  const base = existing
    ? {
        kind: existing.kind, symbol: existing.symbol, date: existing.date, currency: existing.currency,
        qty: existing.kind === 'dividendo' ? '' : fmtQty(existing.qty).replace(/\./g, '').replace(',', '.'),
        price: existing.price ? toInput(existing.price, existing.currency) : '',
        fee: existing.fee ? toInput(existing.fee, existing.currency) : '',
        fx: existing.fx ? String(existing.fx) : '', total: toInput(existing.amount, existing.currency), accountId: existing.accountId || '', note: existing.note || '',
        touched: true,
      }
    : {
        kind: preset.kind || 'compra', symbol: preset.symbol || '', date: todayStr(), currency: 'USD', qty: '', price: '', fee: '',
        total: '', fx: '', fxHint: '', fxTouched: false, accountId: '', note: '', touched: false,
      };
  const s = base;
  if (!existing && !preset.symbol && lastAcc) s.accountId = lastAcc;
  const body = h('div');
  const err = h('p', { class: 'error', hidden: true });
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  const lockedCur = () => {
    const r = d.inv.rows.find((x) => x.symbol === normSymbol(s.symbol));
    return r ? r.currency : null;
  };
  const read = () => {
    const f = body.querySelector('form');
    if (!f) return;
    for (const k of ['kind', 'symbol', 'date', 'currency', 'qty', 'price', 'fee', 'fx', 'total', 'accountId', 'note']) if (f.elements[k]) s[k] = f.elements[k].value;
  };
  const rebuild = () => { read(); const l = lockedCur(); if (l) s.currency = l; build(); };

  function autoTotal(f) {
    if (s.touched) return;
    const cur = f.elements.currency.value;
    const q = parseQty(f.elements.qty.value);
    const px = parsePrice(f.elements.price.value, cur);
    if (!q || !px) return;
    const fee = f.elements.fee.value.trim() ? parseAmount(f.elements.fee.value, cur) || 0 : 0;
    const gross = Math.round(q * px);
    f.elements.total.value = toInput(f.elements.kind.value === 'compra' ? gross + fee : Math.max(0, gross - fee), cur);
  }

  async function submit(ev) {
    ev.preventDefault();
    read();
    const symbol = normSymbol(s.symbol);
    const cur = s.currency;
    const kind = s.kind;
    if (!symbol) return fail('Escribe el símbolo (por ejemplo VOO).');
    if (!s.date) return fail('Elige la fecha.');
    const locked = lockedCur();
    if (locked && locked !== cur) return fail(`${symbol} ya está registrado en ${locked}.`);
    let qty = 0;
    let price = null;
    let fee = 0;
    if (kind !== 'dividendo') {
      qty = parseQty(s.qty);
      if (!qty || qty <= 0) return fail('Escribe la cantidad de acciones (admite fracciones, como 0,0153).');
      if (s.price.trim()) price = parsePrice(s.price, cur);
      if (s.price.trim() && !price) return fail('Revisa el precio por acción.');
      if (s.fee.trim()) { fee = parseAmount(s.fee, cur); if (fee === null || fee < 0) return fail('Revisa la comisión.'); }
    }
    let fx = null;
    if (kind === 'compra' && cur === 'USD' && s.fx.trim()) {
      fx = parseRate(s.fx);
      if (!fx) return fail('Revisa la TRM (pesos por dólar), por ejemplo 3.950,50.');
    }
    let amount = s.total.trim() ? parseAmount(s.total, cur) : null;
    if (!amount && price && qty) {
      const gross = Math.round(qty * price);
      amount = kind === 'compra' ? gross + fee : Math.max(0, gross - fee);
    }
    if (!amount || amount <= 0) return fail(kind === 'dividendo' ? 'Escribe el monto recibido.' : 'Escribe el precio por acción o el total.');
    if (kind !== 'dividendo' && !price) price = Math.round(amount / qty);
    const rec = {
      ...(existing || {}), col: 'inv', id: existing ? existing.id : crypto.randomUUID(),
      symbol, kind, date: s.date, qty, amount, price, fee, fx, currency: cur, accountId: s.accountId,
      note: s.note.trim(), deleted: false, createdAt: existing ? existing.createdAt : Date.now(),
    };
    const rest = d.ops.filter((o) => !existing || o.id !== existing.id);
    const short = firstOversold([...rest, rec]);
    if (short) return fail(`Con esto venderías más acciones de ${short} de las que tenías en esa fecha. Revisa la cantidad o la fecha.`);
    if (s.accountId) await store.setMeta('lastInvAccount', s.accountId);
    closeSheet();
    await saveRecord(rec);
  }

  function build() {
    err.hidden = true;
    const cur = s.currency;
    const div = s.kind === 'dividendo';
    const accs = d.accounts.filter((a) => a.currency === cur && (!a.archived || a.id === s.accountId));
    if (s.accountId && !accs.some((a) => a.id === s.accountId)) s.accountId = '';
    const locked = lockedCur();
    const form = h('form', { class: 'form', onsubmit: submit, oninput: (e) => {
      if (e.target.name === 'total') { s.touched = e.target.value.trim() !== ''; return; }
      if (e.target.name === 'fx') { s.fxTouched = e.target.value.trim() !== ''; return; }
      if (['qty', 'price', 'fee'].includes(e.target.name)) autoTotal(form);
    } },
      h('h3', { text: existing ? 'Editar operación' : 'Nueva operación' }),
      h('label', {}, 'Tipo',
        h('select', { name: 'kind', onchange: rebuild },
          opt('compra', 'Compra', s.kind === 'compra'), opt('venta', 'Venta', s.kind === 'venta'), opt('dividendo', 'Dividendo', s.kind === 'dividendo'))),
      h('label', {}, 'Símbolo',
        h('input', { type: 'text', name: 'symbol', list: 'inv-symbols', autocapitalize: 'characters', spellcheck: 'false', autocomplete: 'off', placeholder: 'VOO, VXUS, NVDA…', value: s.symbol, onchange: rebuild }),
        h('datalist', { id: 'inv-symbols' }, symbols.map((x) => h('option', { value: x })))),
      h('label', {}, 'Fecha', h('input', { type: 'date', name: 'date', value: s.date, required: true, onchange: () => { read(); if (!s.fxTouched) { s.fx = ''; lookupFx(); } } })),
      h('label', {}, 'Moneda',
        h('select', { name: 'currency', disabled: !!locked, onchange: rebuild },
          Object.keys(CURRENCIES).map((c) => opt(c, c, c === cur)))),
      cur === 'USD' && s.kind === 'compra' && h('label', {}, 'Dólar ese día (TRM, pesos por dólar)',
        h('input', { type: 'text', name: 'fx', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Ej: 3.950,50', value: s.fx })),
      cur === 'USD' && s.kind === 'compra' && h('p', { class: 'hint', id: 'fx-hint', style: 'margin:0', text: s.fxHint || 'Opcional: sirve para calcular tu ganancia en pesos y descontar la inflación.' }),
      !div && h('label', {}, 'Cantidad de acciones',
        h('input', { type: 'text', name: 'qty', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Ej: 0,0153', value: s.qty })),
      !div && h('label', {}, `Precio por acción (${cur})`,
        h('input', { type: 'text', name: 'price', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Ej: 200,99', value: s.price })),
      !div && h('label', {}, `Comisión (${cur}, opcional)`,
        h('input', { type: 'text', name: 'fee', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', value: s.fee })),
      h('label', {}, div ? `Monto recibido (${cur})` : s.kind === 'compra' ? `Total pagado (${cur})` : `Total recibido (${cur})`,
        h('input', { class: 'money', type: 'text', name: 'total', inputmode: 'decimal', autocomplete: 'off', value: s.total })),
      !div && h('p', { class: 'hint', style: 'margin:0', text: 'El total se calcula solo con cantidad y precio; si tu bróker te dio otro total exacto, escríbelo y se usa ese.' }),
      h('label', {}, s.kind === 'compra' ? 'Cuenta de donde sale el dinero' : 'Cuenta donde entra el dinero',
        h('select', { name: 'accountId' },
          opt('', 'No afecta ninguna cuenta (ya la tenía)', !s.accountId),
          accs.map((a) => opt(a.id, a.name, a.id === s.accountId)))),
      h('label', {}, 'Nota (opcional)', h('input', { type: 'text', name: 'note', autocomplete: 'off', value: s.note })),
      err,
      h('div', { class: 'row between wrap' },
        existing ? h('button', { class: 'btn danger', type: 'button', text: 'Eliminar', onclick: async () => {
          if (!confirm('¿Eliminar esta operación?')) return;
          const short = firstOversold(d.ops.filter((o) => o.id !== existing.id));
          if (short) return fail(`No se puede: hay ventas posteriores de ${short} que dependen de esta compra.`);
          closeSheet();
          await saveRecord({ ...existing, deleted: true });
        } }) : h('span'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }),
          h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' }))));
    body.replaceChildren(form);
    if (cur === 'USD' && s.kind === 'compra' && !s.fx && !s.fxTouched && s.date) queueMicrotask(lookupFx);
  }

  let fxSeq = 0;
  async function lookupFx() {
    const f = body.querySelector('form');
    if (!f || !f.elements.fx) return;
    const my = ++fxSeq;
    const hint = f.querySelector('#fx-hint');
    if (hint) hint.textContent = 'Buscando la TRM oficial de esa fecha…';
    const r = await fetchTrm(f.elements.date.value);
    if (my !== fxSeq) return;
    const f2 = body.querySelector('form');
    if (!f2 || !f2.elements.fx) return;
    s.fxHint = r.rate ? 'TRM oficial de esa fecha (datos.gov.co). Puedes corregirla.' : r.error;
    if (r.rate && !s.fxTouched) { f2.elements.fx.value = String(r.rate); s.fx = String(r.rate); }
    const h2 = f2.querySelector('#fx-hint');
    if (h2) h2.textContent = s.fxHint;
  }
  const l0 = lockedCur();
  if (l0) s.currency = l0;
  build();
  openSheet(body);
}

// ---------- Reportes ----------
const shortMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('es-CO', { month: 'short' }).replace('.', '');
};

function statTile(label, value, delta) {
  return h('div', { class: 'tile' },
    h('div', { class: 'lbl', text: label }),
    h('div', { class: 'val', text: value }),
    delta && h('div', { class: 'delta ' + (delta.tone || ''), text: delta.text }));
}

// Variación contra el mes anterior. goodWhenUp: subir es bueno (ingresos) o malo (gastos).
function deltaVs(curr, prev, goodWhenUp, prevMonth) {
  if (!prev) return { text: `Sin datos en ${shortMonth(prevMonth)}` };
  const pct = Math.round(((curr - prev) / prev) * 100);
  if (pct === 0) return { text: `= igual que ${shortMonth(prevMonth)}` };
  const up = pct > 0;
  return { text: `${up ? '▲' : '▼'} ${Math.abs(pct)}% vs ${shortMonth(prevMonth)}`, tone: up === goodWhenUp ? 'good' : 'bad' };
}

function renderReportes(d) {
  const root = $('#reportes-body');
  root.replaceChildren();
  const hasData = d.movs.length > 0 || d.debts.length > 0 || d.accounts.length > 0;
  if (!hasData) {
    root.append(h('div', { class: 'empty' }, h('p', { text: 'Cuando registres movimientos aquí verás tus gráficos y presupuestos.' })));
    return;
  }
  const currencies = [...new Set(d.accounts.map((a) => a.currency))];
  if (!currencies.includes(ui.rCur)) ui.rCur = currencies[0] || 'COP';
  const cur = ui.rCur;
  const month = ui.rMonth;
  const thisMonth = monthOf(todayStr());
  const prevMonth = shiftMonth(month, -1);
  const width = root.clientWidth || 360;
  const inner = Math.max(width - 30, 240); // el gráfico vive dentro de una tarjeta con padding

  // --- Filtros (una sola fila, arriba) ---
  root.append(h('div', { class: 'filters' },
    h('div', { class: 'monthbar' },
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Mes anterior', text: '◀', onclick: () => { ui.rMonth = shiftMonth(ui.rMonth, -1); render(); } }),
      h('strong', { text: monthLabel(month) }),
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Mes siguiente', text: '▶', disabled: month >= thisMonth, onclick: () => { ui.rMonth = shiftMonth(ui.rMonth, 1); render(); } })),
    currencies.length > 1 && h('select', { 'aria-label': 'Moneda', onchange: (e) => { ui.rCur = e.target.value; render(); } },
      currencies.map((c) => opt(c, c, c === cur)))));

  // --- Tarjetas de cifras ---
  const tot = monthTotals(d.movs, d.accById, month)[cur] || { ingresos: 0, gastos: 0 };
  const prev = monthTotals(d.movs, d.accById, prevMonth)[cur] || { ingresos: 0, gastos: 0 };
  const bal = tot.ingresos - tot.gastos;
  root.append(h('div', { class: 'tiles' },
    statTile('Ingresos', formatMoney(tot.ingresos, cur), deltaVs(tot.ingresos, prev.ingresos, true, prevMonth)),
    statTile('Gastos', formatMoney(tot.gastos, cur), deltaVs(tot.gastos, prev.gastos, false, prevMonth)),
    statTile('Balance', (bal > 0 ? '+' : bal < 0 ? '−' : '') + formatMoney(Math.abs(bal), cur), { text: bal >= 0 ? 'Ahorraste este mes' : 'Gastaste más de lo que entró', tone: bal >= 0 ? 'good' : 'bad' })));

  // --- Gastos por categoría ---
  const ct = categoryTotals(d.movs, d.accById, month, cur, 'gasto');
  const catName = (id) => (!id ? 'Sin categoría' : d.catById.get(id) ? d.catById.get(id).name : 'Categoría eliminada');
  const entries = [...ct.entries()].map(([id, v]) => ({ id, label: catName(id), value: v })).sort((a, b) => b.value - a.value);
  const total = entries.reduce((x, e) => x + e.value, 0);
  const catCard = h('div', { class: 'chart-card' }, h('h3', { text: 'Gastos por categoría' }));
  if (!entries.length) {
    catCard.append(h('p', { class: 'hint', text: `No hay gastos en ${monthLabel(month)}.` }));
  } else {
    let shown = entries;
    if (entries.length > 8) {
      const rest = entries.slice(7);
      shown = [...entries.slice(0, 7), { id: '__otras', label: `Otras (${rest.length})`, value: rest.reduce((x, e) => x + e.value, 0) }];
    }
    const items = shown.map((e) => ({ label: e.label, value: e.value, share: e.value / total }));
    catCard.append(h('p', { class: 'hint', text: `Total ${formatMoney(total, cur)}` }), rankedBars(items, cur),
      tableView(['Categoría', 'Monto', '%'], entries.map((e) => [e.label, formatMoney(e.value, cur), `${Math.round((e.value / total) * 100)}%`])));
  }
  root.append(catCard);

  // --- Presupuesto ---
  const budMap = new Map(d.budgets.filter((b) => b.currency === cur).map((b) => [b.categoryId, b]));
  const budCard = h('div', { class: 'chart-card' }, h('h3', { text: 'Presupuesto del mes' }));
  const rows = [...budMap.values()]
    .filter((b) => d.catById.has(b.categoryId))
    .map((b) => ({ b, name: catName(b.categoryId), spent: ct.get(b.categoryId) || 0 }))
    .map((r) => ({ ...r, st: budgetState(r.spent, r.b.amount) }))
    .sort((a, b) => b.st.pct - a.st.pct);
  if (!rows.length) {
    budCard.append(h('p', { class: 'hint', text: `Define cuánto quieres gastar al mes por categoría (en ${cur}) y verás cuánto llevas.` }));
  } else {
    const spentSum = rows.reduce((x, r) => x + r.spent, 0);
    const budSum = rows.reduce((x, r) => x + r.b.amount, 0);
    const all = budgetState(spentSum, budSum);
    budCard.append(h('p', { class: 'hint', text: `Llevas ${formatMoney(spentSum, cur)} de ${formatMoney(budSum, cur)} presupuestados (${Math.round(all.pct * 100)}%).` }));
    for (const r of rows) {
      const { st } = r;
      const msg = st.state === 'over' ? `✕ Excedido por ${formatMoney(-st.left, cur)}`
        : st.state === 'warn' ? `⚠ Cerca del límite · te quedan ${formatMoney(st.left, cur)}`
        : `✓ Te quedan ${formatMoney(st.left, cur)}`;
      budCard.append(h('div', { class: 'bud' },
        h('div', { class: 'row' }, h('span', { text: r.name }), h('span', { text: `${formatMoney(r.spent, cur)} / ${formatMoney(r.b.amount, cur)}` })),
        h('div', { class: 'meter ' + st.state, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.min(Math.round(st.pct * 100), 999)), 'aria-label': `${r.name}: ${Math.round(st.pct * 100)}% del presupuesto` },
          h('div', { style: `width:${Math.min(st.pct, 1) * 100}%` })),
        h('div', { class: 'state ' + st.state, text: msg })));
    }
  }
  budCard.append(h('div', { class: 'row wrap', style: 'margin-top:8px' },
    h('button', { class: 'btn', type: 'button', text: rows.length ? 'Editar presupuestos' : 'Definir presupuestos', onclick: () => openBudgetForm(cur) })));
  root.append(budCard);

  // --- Ingresos y gastos, últimos 6 meses ---
  const months = lastMonths(month, 6);
  const ser = monthSeries(d.movs, d.accById, months, cur);
  const serCard = h('div', { class: 'chart-card' }, h('h3', { text: 'Ingresos y gastos' }), h('p', { class: 'hint', text: 'Últimos 6 meses' }));
  if (ser.every((x) => x.ingresos === 0 && x.gastos === 0)) {
    serCard.append(h('p', { class: 'hint', text: 'Todavía no hay ingresos ni gastos en estos meses.' }));
  } else {
    const series = [{ name: 'Ingresos', color: 'var(--s1)' }, { name: 'Gastos', color: 'var(--s2)' }];
    serCard.append(
      h('div', { class: 'legend' }, series.map((x) => h('span', {}, h('i', { style: `background:${x.color}` }), x.name))),
      groupedColumns(inner, ser.map((x) => ({ label: shortMonth(x.month), full: monthLabel(x.month), values: [x.ingresos, x.gastos] })), cur, series),
      tableView(['Mes', 'Ingresos', 'Gastos'], ser.map((x) => [monthLabel(x.month), formatMoney(x.ingresos, cur), formatMoney(x.gastos, cur)])));
  }
  root.append(serCard);

  // --- Ahorro por mes (una tarjeta por meta, en la moneda elegida) ---
  const year = Number(month.slice(0, 4));
  for (const g of savingsGoals(d)) {
    const acc = d.accById.get(g.accountId);
    if (acc.currency !== cur) continue;
    const { monthly, annual } = goalTargets(g);
    const yr = savingsYear(acc.id, d.movs, year);
    const savedYear = sumBy(yr, (x) => x.aportes);
    const card = h('div', { class: 'chart-card' },
      h('h3', { text: `Ahorro por mes · ${goalName(g, acc)}` }),
      h('p', { class: 'hint', text: `${year}: llevas ${formatMoney(savedYear, cur)} de ${formatMoney(annual, cur)} · meta mensual ${formatMoney(monthly, cur)}` }));
    if (yr.every((x) => x.aportes === 0 && x.rendimientos === 0)) {
      card.append(h('p', { class: 'hint', text: `Todavía no hay aportes en ${year}. Usa "＋ Aportar" en el Resumen para registrar el primero.` }));
    } else {
      card.append(
        columnsTarget(inner, yr.map((x) => ({ label: shortMonth(x.month).slice(0, 3), full: monthLabel(x.month), value: x.aportes, extra: x.rendimientos })), cur, monthly, 'Aportes', 'var(--s1)'),
        tableView(['Mes', 'Aportes', 'Meta', 'Rendimientos'], yr.map((x) => [monthLabel(x.month), formatMoney(x.aportes, cur), formatMoney(monthly, cur), formatMoney(x.rendimientos, cur)])));
    }
    root.append(card);
  }

  // --- Patrimonio neto ---
  const pts = netWorthPoints(d.accounts, d.movs, d.flows, d.debts, d.abonos, cur, todayStr(), 6, d.ops);
  const nwCard = h('div', { class: 'chart-card' }, h('h3', { text: 'Patrimonio neto' }),
    h('p', { class: 'hint', text: 'Cuentas + lo que te deben − tarjetas y deudas' + (d.ops.length ? ' + inversiones (a costo)' : '') + ', al cierre de cada mes' }));
  if (pts.length < 2) {
    nwCard.append(h('p', { class: 'hint', text: pts.length ? `Hoy: ${formatMoney(pts[0].value, cur)}. La línea aparece cuando haya al menos dos fechas con datos.` : 'Aún no hay datos para esta moneda.' }));
  } else {
    const fullDate = (p) => (p.today ? 'Hoy · ' : '') + shortDate(p.date);
    const points = pts.map((p) => ({
      date: p.date,
      label: p.today ? 'Hoy' : p.first ? shortDate(p.date) : shortMonth(p.month),
      full: p.today || p.first ? fullDate(p) : `Fin de ${monthLabel(p.month)}`,
      value: p.value,
    }));
    nwCard.append(lineChart(inner, points, cur, 'Patrimonio neto', 'var(--s1)'),
      tableView(['Fecha', 'Patrimonio'], points.map((p) => [p.full, formatMoney(p.value, cur)])));
  }
  root.append(nwCard);
}

function openBudgetForm(cur) {
  const d = ui.data;
  if (!d) return;
  const existing = new Map(d.budgets.filter((b) => b.currency === cur).map((b) => [b.categoryId, b]));
  const cats = d.cats.filter((c) => c.kind === 'gasto' && (!c.archived || existing.has(c.id)));
  const err = h('p', { class: 'error', hidden: true });

  async function submit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const recs = [];
    for (const c of cats) {
      const raw = f.elements['b-' + c.id].value.trim();
      const prev = existing.get(c.id);
      if (!raw) {
        if (prev) recs.push({ ...prev, deleted: true });
        continue;
      }
      const amount = parseAmount(raw, cur);
      if (!amount || amount <= 0) {
        err.textContent = `Revisa el monto de "${c.name}".`;
        err.hidden = false;
        return;
      }
      if (prev && prev.amount === amount) continue;
      recs.push({
        ...(prev || {}),
        col: 'presupuestos',
        id: `bud-${c.id}-${cur}`,
        categoryId: c.id,
        currency: cur,
        amount,
        deleted: false,
      });
    }
    closeSheet();
    if (recs.length) await saveRecords(recs);
  }

  openSheet(h('form', { class: 'form', onsubmit: submit },
    h('h3', { text: `Presupuesto mensual (${cur})` }),
    h('p', { class: 'hint', text: 'Cuánto quieres gastar como máximo cada mes en cada categoría. Déjalo vacío si no quieres presupuesto en esa categoría.' }),
    cats.map((c) => h('label', {}, c.name,
      h('input', { type: 'text', name: 'b-' + c.id, inputmode: 'decimal', placeholder: 'Sin presupuesto', autocomplete: 'off', value: existing.has(c.id) ? toInput(existing.get(c.id).amount, cur) : '' }))),
    err,
    h('div', { class: 'row end wrap' },
      h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }),
      h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' }))));
}

const shortDate = (ds) => {
  const [y, mo, d] = ds.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
};

function debtRow(x, d) {
  const rem = debtRemaining(x, d.abonos);
  const done = debtIsDone(x, d.abonos);
  const overdue = !done && x.dueDate && x.dueDate < todayStr();
  const sub = [`de ${formatMoney(x.amount, x.currency)}`, shortDate(x.date), x.note].filter(Boolean).join(' · ');
  let amt;
  let cls = '';
  if (done) amt = 'Saldada';
  else {
    amt = formatMoney(rem, x.currency);
    cls = x.dir === 'debo' ? 'neg' : 'pos';
  }
  return h('button', { type: 'button', class: 'item' + (done ? ' done' : ''), onclick: () => openDebtDetail(x.id) },
    h('div', { class: 'main' },
      h('div', { class: 'title', text: x.person }),
      h('div', { class: 'sub', text: (x.dir === 'debo' ? 'Le debes · ' : 'Te debe · ') + sub })),
    h('div', { class: 'amt ' + cls }, amt,
      !done && x.dueDate && h('small', { class: overdue ? 'late' : '', text: (overdue ? 'Vencida ' : 'Vence ') + shortDate(x.dueDate) })));
}

// Tarjeta con lo pendiente de una persona (por moneda). Al tocarla filtra las listas de abajo.
function personCard(p) {
  const on = ui.debtPerson === p.key;
  return h('button', { type: 'button', class: 'card person' + (on ? ' sel' : ''), 'aria-pressed': String(on),
    onclick: () => { ui.debtPerson = on ? '' : p.key; render(); } },
    h('div', { class: 'cur', text: p.person }),
    Object.entries(p.byCur).map(([cur, c]) => h('div', { class: 'pc' },
      h('div', { class: 'pc-main ' + (c.net > 0 ? 'pos' : c.net < 0 ? 'neg' : ''),
        text: (c.net > 0 ? 'Te debe ' : c.net < 0 ? 'Le debes ' : 'A mano ') + (c.net === 0 ? '' : formatMoney(Math.abs(c.net), cur)) }),
      c.toMe > 0 && c.iOwe > 0 && h('div', { class: 'sub', text: `Te debe ${formatMoney(c.toMe, cur)} · le debes ${formatMoney(c.iOwe, cur)}` }))));
}

function renderDeudas(d) {
  const root = $('#deudas-body');
  root.replaceChildren();
  if (!d.debts.length) {
    root.append(h('div', { class: 'empty' },
      h('p', { text: 'Aquí llevas lo que te deben y lo que debes a personas o entidades (las tarjetas de crédito ya están en Cuentas).' }),
      h('button', { class: 'btn primary', type: 'button', onclick: () => openDebtForm(), text: '＋ Añadir deuda' })));
    return;
  }
  const parts = Object.entries(d.debtTot).map(([cur, t]) => `${cur}: te deben ${formatMoney(t.toMe, cur)} · debes ${formatMoney(t.iOwe, cur)}`);
  root.append(h('p', { class: 'totals', text: parts.join('   |   ') || 'No tienes deudas pendientes.' }));

  const people = debtsByPerson(d.debts, d.abonos);
  if (ui.debtPerson && !people.some((p) => p.key === ui.debtPerson)) ui.debtPerson = '';
  if (people.length) {
    const box = collapsible('debt-people', 'Por persona', String(people.length));
    box.body.append(h('div', { class: 'cards people' }, people.map(personCard)));
    root.append(box.el);
  }
  const sel = ui.debtPerson;
  if (sel) {
    const p = people.find((q) => q.key === sel);
    root.append(h('p', { class: 'hint' }, `Mostrando solo a ${p.person}. `,
      h('button', { class: 'link-btn', type: 'button', text: 'Quitar filtro', onclick: () => { ui.debtPerson = ''; render(); } })));
  }
  const mine = (x) => !sel || personKey(x.person) === sel;
  const open = d.debts.filter((x) => !debtIsDone(x, d.abonos) && mine(x));
  const done = d.debts.filter((x) => debtIsDone(x, d.abonos) && mine(x));
  const byDue = (a, b) => (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : (a.dueDate || '9999') > (b.dueDate || '9999') ? 1 : (b.createdAt || 0) - (a.createdAt || 0);
  for (const [dir, label] of [['me-deben', 'Me deben'], ['debo', 'Debo']]) {
    const list = open.filter((x) => x.dir === dir).sort(byDue);
    root.append(h('div', { class: 'section-title', text: label }),
      list.length ? h('div', { class: 'list' }, list.map((x) => debtRow(x, d))) : h('p', { class: 'hint', text: 'Nada pendiente.' }));
  }
  if (done.length) {
    root.append(h('details', {}, h('summary', { text: `Saldadas (${done.length})` }), h('div', { class: 'list' }, done.map((x) => debtRow(x, d)))));
  }
}

function renderCategories(d) {
  const root = $('#cat-list');
  root.replaceChildren();
  for (const [kind, label] of [['gasto', 'De gasto'], ['ingreso', 'De ingreso']]) {
    const items = d.cats.filter((c) => c.kind === kind);
    root.append(h('div', { class: 'section-title', text: label }),
      h('div', { class: 'list' }, items.map((c) =>
        h('button', { type: 'button', class: 'item' + (c.archived ? ' archived' : ''), onclick: () => openCatForm(c) },
          h('div', { class: 'title', text: c.name + (c.archived ? ' (archivada)' : '') })))));
  }
}

// ---------- Formularios ----------
async function createSuggested() {
  const t = Date.now();
  const recs = SUGGESTED_ACCOUNTS.map((a, i) => ({
    col: 'cuentas', id: crypto.randomUUID(), name: a.name, type: a.type, currency: a.currency,
    openingBalance: 0, creditLimit: null, archived: false, deleted: false, createdAt: t + i,
  }));
  await saveRecords(recs);
  setStatus('Cuentas creadas con saldo en cero. Toca cada una para poner su saldo inicial (o la deuda, en las tarjetas).', 'ok');
}

async function openMovForm(existing, preset) {
  const d = ui.data;
  if (!d) return;
  const usable = d.accounts.filter((a) => !a.archived || (existing && (existing.accountId === a.id || existing.toAccountId === a.id)));
  if (!usable.length) {
    closeSheet();
    await showTab('resumen');
    setStatus('Primero crea una cuenta.', 'warn');
    return;
  }
  const curOf = (id) => (d.accById.get(id) ? d.accById.get(id).currency : 'COP');
  const last = await store.getMeta('lastAccount');
  const s = existing
    ? {
        kind: existing.kind,
        accountId: existing.accountId,
        toAccountId: existing.toAccountId || '',
        categoryId: existing.categoryId || '',
        date: existing.date,
        note: existing.note || '',
        amount: toInput(existing.amount, curOf(existing.accountId)),
        toAmount: existing.kind === 'transferencia' ? toInput(existing.toAmount ?? existing.amount, curOf(existing.toAccountId)) : '',
        cuotasN: existing.cuotas ? String(existing.cuotas.n) : '1',
        cuotasRate: existing.cuotas && existing.cuotas.rate ? String(+(existing.cuotas.rate * 100).toFixed(4)).replace('.', ',') : '',
      }
    : {
        kind: 'gasto',
        accountId: usable.some((a) => a.id === last) ? last : usable[0].id,
        toAccountId: '',
        categoryId: '',
        date: todayStr(),
        note: '',
        amount: '',
        toAmount: '',
        cuotasN: '1',
        cuotasRate: '',
      };
  if (!existing && preset) {
    Object.assign(s, preset);
    if (s.accountId === s.toAccountId) {
      // Como origen del pago, una cuenta que no sea la tarjeta (de la misma moneda si se puede).
      const toCur = curOf(s.toAccountId);
      const from = usable.find((a) => a.id !== s.toAccountId && a.type !== 'credito' && a.currency === toCur)
        || usable.find((a) => a.id !== s.toAccountId);
      if (from) s.accountId = from.id;
    }
  }

  const body = h('div');
  const err = h('p', { class: 'error', hidden: true });
  const read = () => {
    const f = body.querySelector('form');
    if (!f) return;
    for (const k of ['amount', 'toAmount', 'accountId', 'toAccountId', 'categoryId', 'date', 'note', 'cuotasN', 'cuotasRate']) {
      if (f.elements[k]) s[k] = f.elements[k].value;
    }
  };
  const rebuild = () => { read(); build(); };
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };

  async function submit(ev) {
    ev.preventDefault();
    read();
    const cur = curOf(s.accountId);
    const amount = parseAmount(s.amount, cur);
    if (!amount || amount <= 0) return fail('Ingresa un monto mayor que cero.');
    if (!s.date) return fail('Elige una fecha.');
    const rec = {
      ...(existing || {}),
      col: 'movs',
      id: existing ? existing.id : crypto.randomUUID(),
      kind: s.kind,
      date: s.date,
      accountId: s.accountId,
      amount,
      note: s.note.trim(),
      createdAt: existing ? existing.createdAt : Date.now(),
      deleted: false,
    };
    if (s.kind === 'transferencia') {
      if (!s.toAccountId || s.toAccountId === s.accountId) return fail('Elige una cuenta de destino distinta.');
      const toCur = curOf(s.toAccountId);
      let toAmount = amount;
      if (toCur !== cur) {
        toAmount = parseAmount(s.toAmount, toCur);
        if (!toAmount || toAmount <= 0) return fail(`Ingresa el monto que recibe la cuenta destino (${toCur}).`);
      }
      rec.toAccountId = s.toAccountId;
      rec.toAmount = toAmount;
      rec.categoryId = '';
    } else {
      rec.categoryId = s.categoryId;
      delete rec.toAccountId;
      delete rec.toAmount;
    }
    const isCard = d.accById.get(s.accountId) && d.accById.get(s.accountId).type === 'credito';
    const n = Number(s.cuotasN) || 1;
    if (s.kind === 'gasto' && isCard && n > 1) {
      const pct = s.cuotasRate.trim() ? parseQty(s.cuotasRate) : 0;
      if (pct === null || pct < 0 || pct > 10) return fail('El interés mensual debe estar entre 0 y 10 % (por ejemplo 1,89).');
      rec.cuotas = { n, rate: pct / 100 };
    } else delete rec.cuotas;
    await store.setMeta('lastAccount', s.accountId);
    closeSheet();
    await saveRecord(rec);
  }

  function build() {
    err.hidden = true;
    const cur = curOf(s.accountId);
    const isTransfer = s.kind === 'transferencia';
    const fields = [];

    fields.push(h('div', { class: 'seg' }, [['gasto', 'Gasto'], ['ingreso', 'Ingreso'], ['transferencia', 'Transferencia']].map(([k, label]) =>
      h('button', { type: 'button', class: s.kind === k ? 'on' : '', text: label, onclick: () => {
        read();
        if (s.kind !== k) { s.kind = k; s.categoryId = ''; }
        build();
      } }))));

    fields.push(h('label', {}, `Monto (${cur})`,
      h('input', { class: 'money', type: 'text', name: 'amount', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', value: s.amount })));

    fields.push(h('label', {}, isTransfer ? 'Desde' : 'Cuenta',
      h('select', { name: 'accountId', onchange: rebuild },
        usable.map((a) => opt(a.id, `${a.name} (${a.currency})`, a.id === s.accountId)))));

    if (isTransfer) {
      if (s.toAccountId === s.accountId) s.toAccountId = '';
      fields.push(h('label', {}, 'Hacia',
        h('select', { name: 'toAccountId', onchange: rebuild },
          opt('', 'Elige la cuenta destino', !s.toAccountId),
          usable.filter((a) => a.id !== s.accountId).map((a) => opt(a.id, `${a.name} (${a.currency})`, a.id === s.toAccountId)))));
      if (s.toAccountId && curOf(s.toAccountId) !== cur) {
        fields.push(h('label', {}, `Monto que recibe (${curOf(s.toAccountId)})`,
          h('input', { type: 'text', name: 'toAmount', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', value: s.toAmount })));
      }
    } else {
      const cats = d.cats.filter((c) => c.kind === s.kind && (!c.archived || c.id === s.categoryId));
      fields.push(h('label', {}, 'Categoría',
        h('select', { name: 'categoryId' },
          opt('', 'Sin categoría', !s.categoryId),
          cats.map((c) => opt(c.id, c.name, c.id === s.categoryId)))));
    }

    const acc = d.accById.get(s.accountId);
    if (s.kind === 'gasto' && acc && acc.type === 'credito') {
      const hint = h('p', { class: 'hint', style: 'margin:0' });
      const showPlan = () => {
        const f = body.querySelector('form');
        const n = Number(f ? f.elements.cuotasN.value : s.cuotasN) || 1;
        const rateWrap = body.querySelector('#rate-wrap');
        if (rateWrap) rateWrap.hidden = n <= 1;
        if (n <= 1) { hint.textContent = acc.cutDay ? `Una sola cuota: llega completa en el próximo corte (día ${acc.cutDay}).` : ''; return; }
        const amount = parseAmount(f ? f.elements.amount.value : s.amount, cur);
        const pct = parseQty(f ? f.elements.cuotasRate.value : s.cuotasRate) || 0;
        if (!amount) { hint.textContent = `${n} cuotas${acc.cutDay ? `, una en cada corte (día ${acc.cutDay})` : ', una por mes'}.`; return; }
        const plan = installmentPlan({ amount, date: (f ? f.elements.date.value : s.date) || todayStr(), cuotas: { n, rate: pct / 100 } }, acc);
        hint.textContent = `${n} cuotas de ${formatMoney(plan.cuota, cur)}${pct ? ' (aprox.)' : ''} · primera el ${shortDate(plan.rows[0].cut)} · total ${formatMoney(plan.total, cur)}${plan.total > amount ? ` (${formatMoney(plan.total - amount, cur)} de intereses)` : ''}.`;
      };
      const ns = [1, 2, 3, 4, 5, 6, 9, 12, 18, 24, 36, 48];
      if (!ns.includes(Number(s.cuotasN))) ns.push(Number(s.cuotasN));
      fields.push(h('label', {}, 'Cuotas',
        h('select', { name: 'cuotasN', onchange: showPlan }, ns.sort((a, b) => a - b).map((n) => opt(String(n), n === 1 ? '1 (sin diferir)' : `${n} cuotas`, String(n) === String(s.cuotasN))))));
      fields.push(h('label', { id: 'rate-wrap' }, 'Interés mensual (%) — déjalo vacío si es sin interés',
        h('input', { type: 'text', name: 'cuotasRate', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Ej: 1,89', value: s.cuotasRate, oninput: showPlan })));
      fields.push(hint);
      queueMicrotask(() => {
        const f = body.querySelector('form');
        if (f) { f.elements.amount.addEventListener('input', showPlan); f.elements.date.addEventListener('change', showPlan); }
        showPlan();
      });
    }

    fields.push(h('label', {}, 'Fecha', h('input', { type: 'date', name: 'date', value: s.date, required: true })));
    fields.push(h('label', {}, 'Nota (opcional)', h('input', { type: 'text', name: 'note', autocomplete: 'off', value: s.note })));

    const buttons = h('div', { class: 'row end wrap' },
      h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }),
      existing && h('button', { class: 'btn danger', type: 'button', text: 'Eliminar', onclick: async () => {
        if (!confirm('¿Eliminar este movimiento?')) return;
        closeSheet();
        await saveRecord({ ...existing, deleted: true });
      } }),
      h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' }));

    body.replaceChildren(h('form', { class: 'form', onsubmit: submit },
      h('h3', { text: existing ? 'Editar movimiento' : 'Nuevo movimiento' }), fields, err, buttons));
  }

  build();
  openSheet(body);
  if (!existing) {
    const inp = body.querySelector('[name=amount]');
    if (inp) inp.focus();
  }
}

// ---------- Deudas: formularios ----------
function openDebtForm(existing) {
  const d = ui.data;
  if (!d) return;
  const hasAbonos = !!existing && d.abonos.some((a) => a.debtId === existing.id);
  const s = existing
    ? {
        dir: existing.dir, person: existing.person, currency: existing.currency,
        amount: toInput(existing.amount, existing.currency), date: existing.date,
        dueDate: existing.dueDate || '', accountId: existing.accountId || '', note: existing.note || '',
      }
    : { dir: 'me-deben', person: '', currency: 'COP', amount: '', date: todayStr(), dueDate: '', accountId: '', note: '' };

  const body = h('div');
  const err = h('p', { class: 'error', hidden: true });
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  const read = () => {
    const f = body.querySelector('form');
    if (!f) return;
    for (const k of ['person', 'currency', 'amount', 'date', 'dueDate', 'accountId', 'note']) if (f.elements[k]) s[k] = f.elements[k].value;
  };
  const rebuild = () => { read(); build(); };

  async function submit(ev) {
    ev.preventDefault();
    read();
    const person = s.person.trim();
    if (!person) return fail('Escribe con quién es la deuda.');
    const amount = parseAmount(s.amount, s.currency);
    if (!amount || amount <= 0) return fail('Ingresa un monto mayor que cero.');
    if (!s.date) return fail('Elige la fecha.');
    if (s.dueDate && s.dueDate < s.date) return fail('El vencimiento no puede ser anterior a la fecha de la deuda.');
    if (existing) {
      const paid = existing.amount - debtRemaining(existing, d.abonos);
      if (amount < paid) return fail(`El monto no puede ser menor a lo ya abonado (${formatMoney(paid, s.currency)}).`);
    }
    closeSheet();
    await saveRecord({
      ...(existing || {}),
      col: 'deudas',
      id: existing ? existing.id : crypto.randomUUID(),
      dir: s.dir,
      person,
      currency: s.currency,
      amount,
      date: s.date,
      dueDate: s.dueDate || '',
      accountId: s.accountId || '',
      note: s.note.trim(),
      closed: existing ? !!existing.closed : false,
      deleted: false,
      createdAt: existing ? existing.createdAt : Date.now(),
    });
    if (existing) openDebtDetail(existing.id);
  }

  function build() {
    err.hidden = true;
    const persons = [...new Set(d.debts.map((x) => x.person))].sort((a, b) => a.localeCompare(b, 'es'));
    const accs = d.accounts.filter((a) => a.currency === s.currency && (!a.archived || a.id === s.accountId));
    if (s.accountId && !accs.some((a) => a.id === s.accountId)) s.accountId = '';
    const owe = s.dir === 'debo';
    const fields = [
      h('div', { class: 'seg', style: 'grid-template-columns:1fr 1fr' }, [['me-deben', 'Me deben'], ['debo', 'Debo']].map(([k, label]) =>
        h('button', { type: 'button', class: s.dir === k ? 'on' : '', text: label, disabled: hasAbonos && s.dir !== k, onclick: () => { read(); s.dir = k; build(); } }))),
      h('label', {}, owe ? 'A quién le debes' : 'Quién te debe',
        h('input', { type: 'text', name: 'person', list: 'persons', autocomplete: 'off', value: s.person, required: true }),
        h('datalist', { id: 'persons' }, persons.map((p) => h('option', { value: p })))),
      h('label', {}, hasAbonos ? 'Moneda (no se puede cambiar: ya tiene abonos)' : 'Moneda',
        h('select', { name: 'currency', disabled: hasAbonos, onchange: rebuild },
          Object.entries(CURRENCIES).map(([k, c]) => opt(k, c.label, k === s.currency)))),
      h('label', {}, `Monto total (${s.currency})`,
        h('input', { class: 'money', type: 'text', name: 'amount', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', value: s.amount })),
      h('label', {}, 'Fecha', h('input', { type: 'date', name: 'date', value: s.date, required: true })),
      h('label', {}, 'Vence (opcional)', h('input', { type: 'date', name: 'dueDate', value: s.dueDate })),
      h('label', {}, owe ? 'Cuenta donde entró el dinero (opcional)' : 'Cuenta de donde salió el dinero (opcional)',
        h('select', { name: 'accountId' },
          opt('', 'No afecta ninguna cuenta', !s.accountId),
          accs.map((a) => opt(a.id, a.name, a.id === s.accountId)))),
      h('label', {}, 'Nota (opcional)', h('input', { type: 'text', name: 'note', autocomplete: 'off', value: s.note })),
    ];
    const buttons = h('div', { class: 'row end wrap' },
      h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => (existing ? openDebtDetail(existing.id) : closeSheet()) }),
      h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' }));
    body.replaceChildren(h('form', { class: 'form', onsubmit: submit },
      h('h3', { text: existing ? 'Editar deuda' : 'Nueva deuda' }), fields, err, buttons));
  }

  build();
  openSheet(body);
}

function openDebtDetail(id) {
  const d = ui.data;
  const x = d && d.debts.find((y) => y.id === id);
  if (!x) { closeSheet(); return; }
  const rem = debtRemaining(x, d.abonos);
  const done = debtIsDone(x, d.abonos);
  const paid = x.amount - rem;
  const mine = d.abonos.filter((a) => a.debtId === x.id).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
  const acc = x.accountId ? d.accById.get(x.accountId) : null;
  const kv = (k, v) => h('div', { class: 'kv' }, h('span', { text: k }), h('strong', { text: v }));

  const status = x.closed && rem > 0 ? 'Saldada (cerrada a mano)' : done ? 'Saldada' : 'Pendiente';
  const content = h('div', { class: 'form' },
    h('h3', { text: `${x.dir === 'debo' ? 'Le debes a' : 'Te debe'} ${x.person}` }),
    h('div', {},
      kv('Estado', status),
      kv('Monto total', formatMoney(x.amount, x.currency)),
      kv(x.dir === 'debo' ? 'Has pagado' : 'Te han pagado', formatMoney(paid, x.currency)),
      kv('Falta', formatMoney(Math.max(rem, 0), x.currency)),
      kv('Fecha', shortDate(x.date)),
      x.dueDate && kv('Vence', shortDate(x.dueDate)),
      acc && kv(x.dir === 'debo' ? 'Entró a' : 'Salió de', acc.name),
      x.note && kv('Nota', x.note)),
    mine.length > 0 && h('div', {},
      h('div', { class: 'section-title', text: 'Abonos' }),
      h('div', { class: 'list' }, mine.map((a) => {
        const aa = a.accountId ? d.accById.get(a.accountId) : null;
        return h('button', { type: 'button', class: 'item', onclick: () => openAbonoForm(x.id, a) },
          h('div', { class: 'main' },
            h('div', { class: 'title', text: shortDate(a.date) }),
            h('div', { class: 'sub', text: [a.note, aa ? aa.name : null].filter(Boolean).join(' · ') || 'Sin cuenta asociada' })),
          h('div', { class: 'amt', text: formatMoney(a.amount, x.currency) }));
      }))),
    h('div', { class: 'row wrap' },
      !done && h('button', { class: 'btn primary', type: 'button', text: x.dir === 'debo' ? 'Registrar pago' : 'Registrar abono', onclick: () => openAbonoForm(x.id) }),
      h('button', { class: 'btn', type: 'button', text: 'Editar', onclick: () => openDebtForm(x) }),
      done && x.closed
        ? h('button', { class: 'btn', type: 'button', text: 'Reabrir', onclick: async () => { await saveRecord({ ...x, closed: false, closedAt: '' }); openDebtDetail(x.id); } })
        : !done && h('button', { class: 'btn', type: 'button', text: 'Marcar saldada', onclick: async () => {
            if (!confirm('¿Marcar como saldada? Lo que falta deja de contar como pendiente.')) return;
            await saveRecord({ ...x, closed: true, closedAt: todayStr() });
            openDebtDetail(x.id);
          } })),
    h('div', { class: 'row between wrap' },
      h('button', { class: 'btn danger', type: 'button', text: 'Eliminar', onclick: async () => {
        if (!confirm('¿Eliminar esta deuda? También se borran sus abonos y su efecto en los saldos de tus cuentas.')) return;
        closeSheet();
        await saveRecord({ ...x, deleted: true });
      } }),
      h('button', { class: 'btn', type: 'button', text: 'Cerrar', onclick: closeSheet })));
  openSheet(content);
}

async function openAbonoForm(debtId, existing) {
  const d = ui.data;
  const x = d && d.debts.find((y) => y.id === debtId);
  if (!x) return;
  const rem = debtRemaining(x, d.abonos) + (existing ? existing.amount : 0);
  const accs = d.accounts.filter((a) => a.currency === x.currency && (!a.archived || (existing && a.id === existing.accountId)));
  const last = await store.getMeta('lastAccount');
  const s = existing
    ? { amount: toInput(existing.amount, x.currency), date: existing.date, accountId: existing.accountId || '', note: existing.note || '' }
    : { amount: toInput(rem, x.currency), date: todayStr(), accountId: accs.some((a) => a.id === last) ? last : '', note: '' };
  const err = h('p', { class: 'error', hidden: true });
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };

  async function submit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const amount = parseAmount(f.elements.amount.value, x.currency);
    if (!amount || amount <= 0) return fail('Ingresa un monto mayor que cero.');
    if (amount > rem) return fail(`Eso supera lo que falta (${formatMoney(rem, x.currency)}).`);
    if (!f.elements.date.value) return fail('Elige la fecha.');
    const accountId = f.elements.accountId.value;
    if (accountId) await store.setMeta('lastAccount', accountId);
    closeSheet();
    await saveRecord({
      ...(existing || {}),
      col: 'abonos',
      id: existing ? existing.id : crypto.randomUUID(),
      debtId: x.id,
      amount,
      date: f.elements.date.value,
      accountId,
      note: f.elements.note.value.trim(),
      deleted: false,
      createdAt: existing ? existing.createdAt : Date.now(),
    });
    openDebtDetail(x.id);
  }

  const owe = x.dir === 'debo';
  openSheet(h('form', { class: 'form', onsubmit: submit },
    h('h3', { text: `${existing ? 'Editar' : 'Nuevo'} ${owe ? 'pago' : 'abono'} · ${x.person}` }),
    h('p', { class: 'hint', text: `Falta ${formatMoney(rem, x.currency)}` }),
    h('label', {}, `Monto (${x.currency})`,
      h('input', { class: 'money', type: 'text', name: 'amount', inputmode: 'decimal', autocomplete: 'off', value: s.amount })),
    h('label', {}, 'Fecha', h('input', { type: 'date', name: 'date', value: s.date, required: true })),
    h('label', {}, owe ? 'Cuenta de donde sale el pago (opcional)' : 'Cuenta donde entra el abono (opcional)',
      h('select', { name: 'accountId' },
        opt('', 'No afecta ninguna cuenta', !s.accountId),
        accs.map((a) => opt(a.id, a.name, a.id === s.accountId)))),
    h('label', {}, 'Nota (opcional)', h('input', { type: 'text', name: 'note', autocomplete: 'off', value: s.note })),
    err,
    h('div', { class: 'row end wrap' },
      h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => openDebtDetail(x.id) }),
      existing && h('button', { class: 'btn danger', type: 'button', text: 'Eliminar', onclick: async () => {
        if (!confirm('¿Eliminar este abono?')) return;
        closeSheet();
        await saveRecord({ ...existing, deleted: true });
        openDebtDetail(x.id);
      } }),
      h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' }))));
  if (!existing) {
    const inp = $('#sheet [name=amount]');
    if (inp) { inp.focus(); inp.select(); }
  }
}

// Elimina una cuenta. Sus movimientos (y transferencias que la tocan) se eliminan con ella;
// deudas, abonos y operaciones de inversión se conservan sin cuenta asociada.
async function deleteAccount(acc) {
  const d = ui.data;
  const movs = d.realMovs.filter((m) => m.accountId === acc.id || m.toAccountId === acc.id);
  const debts = d.debts.filter((x) => x.accountId === acc.id);
  const abonos = d.abonos.filter((x) => x.accountId === acc.id);
  const ops = d.ops.filter((x) => x.accountId === acc.id);
  const goals = d.goals.filter((g) => g.accountId === acc.id);
  const lines = [`¿Eliminar la cuenta "${acc.name}"?`];
  if (movs.length) lines.push(`\nSe eliminarán también sus ${movs.length} movimiento(s), incluidas las transferencias que la tocan. Los totales y reportes cambiarán.`);
  if (debts.length + abonos.length + ops.length) lines.push(`\nLas deudas, abonos y operaciones de inversión que usaban esta cuenta se conservan, pero quedan sin cuenta asociada.`);
  if (goals.length) lines.push('\nTambién se elimina su meta de ahorro.');
  lines.push(`\nPodrás recuperarla desde Ajustes → Papelera durante ${TRASH_DAYS} días.`);
  if (!confirm(lines.join(''))) return;
  closeSheet();
  if (ui.filterAccount === acc.id) ui.filterAccount = '';
  const trash = 'del-' + crypto.randomUUID().slice(0, 8);
  const unlink = (x) => ({ ...x, accountId: '', prevAccountId: acc.id, trash });
  await saveRecords([
    { ...acc, deleted: true, trash },
    ...movs.map((m) => ({ ...m, deleted: true, trash })),
    ...goals.map((g) => ({ ...g, deleted: true, trash })),
    ...debts.map(unlink),
    ...abonos.map(unlink),
    ...ops.map(unlink),
  ]);
}

function openAccountForm(existing, preset) {
  const d = ui.data;
  if (!d) return;
  const hasMovs = !!existing && d.movs.some((m) => m.accountId === existing.id || m.toAccountId === existing.id);
  const s = existing
    ? {
        name: existing.name,
        type: existing.type,
        currency: existing.currency,
        opening: toInput(existing.type === 'credito' ? -(existing.openingBalance || 0) : existing.openingBalance || 0, existing.currency),
        limit: existing.creditLimit ? toInput(existing.creditLimit, existing.currency) : '',
        cutDay: existing.cutDay ? String(existing.cutDay) : '',
        payDay: existing.payDay ? String(existing.payDay) : '',
        archived: !!existing.archived,
      }
    : { name: '', type: 'debito', currency: 'COP', opening: '', limit: '', cutDay: '', payDay: '', archived: false, ...(preset || {}) };

  const body = h('div');
  const err = h('p', { class: 'error', hidden: true });
  const read = () => {
    const f = body.querySelector('form');
    if (!f) return;
    for (const k of ['name', 'type', 'currency', 'opening', 'limit', 'cutDay', 'payDay']) if (f.elements[k]) s[k] = f.elements[k].value;
    if (f.elements.archived) s.archived = f.elements.archived.checked;
  };
  const rebuild = () => { read(); build(); };

  async function submit(ev) {
    ev.preventDefault();
    read();
    const name = s.name.trim();
    if (!name) { err.textContent = 'Ponle un nombre a la cuenta.'; err.hidden = false; return; }
    const credit = s.type === 'credito';
    const parsed = parseAmount(s.opening, s.currency, { signed: !credit }) ?? 0;
    const openingBalance = credit ? -Math.abs(parsed) : parsed;
    const creditLimit = credit && s.limit.trim() ? parseAmount(s.limit, s.currency) : null;
    let cutDay = null;
    let payDay = null;
    if (credit && (s.cutDay.trim() || s.payDay.trim())) {
      cutDay = Number(s.cutDay);
      payDay = Number(s.payDay);
      const okDay = (n) => Number.isInteger(n) && n >= 1 && n <= 31;
      if (!okDay(cutDay) || !okDay(payDay)) {
        err.textContent = 'Para el corte y el pago pon ambos días, entre 1 y 31 (o deja los dos vacíos).';
        err.hidden = false;
        return;
      }
    }
    closeSheet();
    await saveRecord({
      ...(existing || {}),
      col: 'cuentas',
      id: existing ? existing.id : crypto.randomUUID(),
      name,
      type: s.type,
      currency: s.currency,
      openingBalance,
      creditLimit,
      cutDay,
      payDay,
      archived: !!s.archived,
      deleted: false,
      createdAt: existing ? existing.createdAt : Date.now(),
    });
  }

  function build() {
    err.hidden = true;
    const credit = s.type === 'credito';
    const fields = [
      h('label', {}, 'Nombre', h('input', { type: 'text', name: 'name', autocomplete: 'off', value: s.name, required: true })),
      h('label', {}, 'Tipo',
        h('select', { name: 'type', onchange: rebuild },
          Object.entries(ACCOUNT_TYPES).map(([k, label]) => opt(k, label, k === s.type)))),
      h('label', {}, hasMovs ? 'Moneda (no se puede cambiar: ya tiene movimientos)' : 'Moneda',
        h('select', { name: 'currency', disabled: hasMovs, onchange: rebuild },
          Object.entries(CURRENCIES).map(([k, c]) => opt(k, c.label, k === s.currency)))),
      h('label', {}, credit ? 'Deuda actual (lo que debes hoy)' : 'Saldo inicial',
        h('input', { type: 'text', name: 'opening', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', value: s.opening })),
      credit && h('label', {}, 'Cupo total (opcional)',
        h('input', { type: 'text', name: 'limit', inputmode: 'decimal', placeholder: 'Para ver cuánto te queda disponible', autocomplete: 'off', value: s.limit })),
      credit && h('div', { class: 'row' },
        h('label', { style: 'flex:1' }, 'Día de corte',
          h('input', { type: 'text', name: 'cutDay', inputmode: 'numeric', maxlength: '2', placeholder: 'Ej. 24', autocomplete: 'off', value: s.cutDay })),
        h('label', { style: 'flex:1' }, 'Día límite de pago',
          h('input', { type: 'text', name: 'payDay', inputmode: 'numeric', maxlength: '2', placeholder: 'Ej. 14', autocomplete: 'off', value: s.payDay }))),
      existing && h('label', { class: 'check' },
        h('input', { type: 'checkbox', name: 'archived', checked: s.archived }), 'Archivada (la oculta del resumen y de los formularios)'),
    ];
    const buttons = h('div', { class: 'row between wrap' },
      existing ? h('button', { class: 'btn danger', type: 'button', text: 'Eliminar cuenta', onclick: () => deleteAccount(existing) }) : h('span'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }),
        h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' })));
    body.replaceChildren(h('form', { class: 'form', onsubmit: submit },
      h('h3', { text: existing ? 'Editar cuenta' : 'Nueva cuenta' }), fields, err, buttons));
  }

  build();
  openSheet(body);
}

function openCatForm(existing) {
  const d = ui.data;
  if (!d) return;
  const s = existing
    ? { name: existing.name, kind: existing.kind, archived: !!existing.archived }
    : { name: '', kind: 'gasto', archived: false };
  const err = h('p', { class: 'error', hidden: true });

  async function submit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const name = f.elements.name.value.trim();
    if (!name) { err.textContent = 'Ponle un nombre a la categoría.'; err.hidden = false; return; }
    closeSheet();
    await saveRecord({
      ...(existing || {}),
      col: 'categorias',
      id: existing ? existing.id : crypto.randomUUID(),
      name,
      kind: f.elements.kind.value,
      archived: f.elements.archived ? f.elements.archived.checked : false,
      deleted: false,
      order: existing && existing.order !== undefined ? existing.order : 1000 + d.cats.length,
    });
  }

  openSheet(h('form', { class: 'form', onsubmit: submit },
    h('h3', { text: existing ? 'Editar categoría' : 'Nueva categoría' }),
    h('label', {}, 'Nombre', h('input', { type: 'text', name: 'name', autocomplete: 'off', value: s.name, required: true })),
    h('label', {}, 'Tipo',
      h('select', { name: 'kind', disabled: !!existing },
        opt('gasto', 'Gasto', s.kind === 'gasto'), opt('ingreso', 'Ingreso', s.kind === 'ingreso'))),
    existing && h('label', { class: 'check' },
      h('input', { type: 'checkbox', name: 'archived', checked: s.archived }), 'Archivada'),
    err,
    h('div', { class: 'row end wrap' },
      h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }),
      h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' }))));
}

// ---------- Sincronización ----------
function makeGh() {
  const cfg = loadCfg();
  return createGithub({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch || 'main', path: cfg.path || 'datos.enc.json', token: cfg.token });
}

// Limpieza automática del historial del repositorio de datos: como máximo cada 30 días.
const COMPACT_EVERY = 30 * 864e5;
let compacting = false;
async function maybeCompact(gh, force = false) {
  const d = ui.data;
  if (compacting || !d) return null;
  const last = d.compactRec ? d.compactRec.at : 0;
  if (!force && Date.now() - last < COMPACT_EVERY) return null;
  compacting = true;
  try {
    const r = await gh.compact({ now: Date.now() });
    if (r.raced) return r; // otro dispositivo subió algo: se intenta en la próxima sincronización
    await saveRecord({ col: 'config', id: 'compactacion', at: Date.now(), before: r.before, after: r.after, deleted: false });
    return r;
  } catch (e) {
    if (force) throw e;
    return null;
  } finally {
    compacting = false;
  }
}

async function doSync(interactive) {
  if (syncing || compacting) return;
  if (!isConfigured()) {
    if (interactive) {
      await showTab('ajustes');
      setStatus('Configura primero la sincronización.', 'warn');
    }
    return;
  }
  syncing = true;
  $('#btn-sync').disabled = true;
  setStatus('Sincronizando…');
  try {
    const gh = makeGh();
    const getPassphrase = async ({ isNew }) => {
      if (!interactive) throw new SyncError('NEEDS_PASSPHRASE');
      const p = await askPassphrase({ isNew });
      if (!p) throw new SyncError('CANCELLED');
      return p;
    };
    const res = await runSync({ store, gh, getPassphrase });
    await render();
    setStatus(`Sincronizado: ${res.pulled} cambio(s) recibido(s)${res.pushed ? ', cambios subidos' : ''}.`, 'ok');
    maybeCompact(gh);
  } catch (e) {
    if (e.code === 'NEEDS_PASSPHRASE') setStatus('Toca "Sincronizar" para ingresar la contraseña en este dispositivo.', 'warn');
    else if (e.code === 'CANCELLED') await showIdleStatus();
    else setStatus(errorMessage(e), 'err');
  } finally {
    syncing = false;
    $('#btn-sync').disabled = false;
  }
}

function scheduleSync() {
  if (!isConfigured()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync(false), 4000);
}

// ---------- Ajustes ----------
function fillCfgForm() {
  const c = loadCfg();
  $('#cfg-owner').value = c.owner || '';
  $('#cfg-repo').value = c.repo || '';
  $('#cfg-branch').value = c.branch || '';
  $('#cfg-path').value = c.path || '';
  $('#cfg-token').value = c.token || '';
  fillPxState();
  $('#device-info').textContent = `ID del dispositivo: ${deviceId} · Versión ${VERSION}`;
}

function fillPxState() {
  $('#px-key').placeholder = getPxKey() ? 'Clave guardada en este dispositivo (escribe otra para cambiarla)' : 'Pega aquí tu clave';
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bindUi() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#btn-sync').addEventListener('click', () => doSync(true));
  $('#fab').addEventListener('click', () => (ui.tab === 'deudas' ? openDebtForm() : ui.tab === 'inv' ? openInvForm() : openMovForm()));
  $('#btn-privacy').addEventListener('click', () => setPrivacy(!moneyHidden()));
  $('#btn-settings').addEventListener('click', () => showTab(ui.tab === 'ajustes' ? 'resumen' : 'ajustes'));
  $('#px-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const k = $('#px-key').value.trim();
    try { if (k) localStorage.setItem(PX_KEY, k); else localStorage.removeItem(PX_KEY); } catch { /* sin almacenamiento */ }
    $('#px-key').value = '';
    fillPxState();
  });
  $('#px-clear').addEventListener('click', () => {
    try { localStorage.removeItem(PX_KEY); } catch { /* sin almacenamiento */ }
    fillPxState();
  });
  $('#btn-add-cat').addEventListener('click', () => openCatForm());

  $('#cfg-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const prev = loadCfg();
    const next = {
      owner: $('#cfg-owner').value.trim(),
      repo: $('#cfg-repo').value.trim(),
      branch: $('#cfg-branch').value.trim() || 'main',
      path: $('#cfg-path').value.trim() || 'datos.enc.json',
      token: $('#cfg-token').value.trim(),
    };
    // Si cambia el destino, la clave guardada ya no aplica.
    if (prev.owner !== next.owner || prev.repo !== next.repo || prev.path !== next.path) await store.delMeta('syncKey');
    saveCfg(next);
    await showTab('resumen');
    await doSync(true);
  });

  $('#btn-forget-key').addEventListener('click', async () => {
    await store.delMeta('syncKey');
    setStatus('Contraseña olvidada en este dispositivo: se pedirá en la próxima sincronización.', 'warn');
  });

  $('#btn-export').addEventListener('click', async () => {
    const pass = await askPassphrase({
      isNew: true,
      title: 'Contraseña del respaldo',
      text: 'Cifra el archivo de respaldo. Puedes usar la misma contraseña de sincronización.',
    });
    if (!pass) return;
    try {
      const text = await exportEncrypted(store, pass);
      download(`finanzas-respaldo-${todayStr()}.json`, text);
      setStatus('Respaldo exportado.', 'ok');
    } catch (e) {
      setStatus(errorMessage(e), 'err');
    }
  });

  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    const pass = await askPassphrase({ isNew: false, title: 'Contraseña del respaldo', text: 'Ingresa la contraseña con la que se cifró este archivo.' });
    if (!pass) return;
    try {
      const n = await importEncrypted(store, await file.text(), pass);
      await render();
      setStatus(`Respaldo importado: ${n} registro(s) nuevos o más recientes.`, 'ok');
      scheduleSync();
    } catch (e) {
      setStatus(errorMessage(e), 'err');
    }
  });

  // Al girar el celular o cambiar el tamaño, los gráficos se redibujan al ancho nuevo.
  let resizeTimer = null;
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (ui.tab !== 'reportes' || window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });

  window.addEventListener('online', () => doSync(false));
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !isConfigured()) return;
    const last = (await store.getMeta('lastSync')) || 0;
    if (Date.now() - last > 2 * 60 * 1000) doSync(false);
  });
}

// ---------- Inicio ----------
async function init() {
  store = await openStore();
  deviceId = await store.getMeta('deviceId');
  if (!deviceId) {
    deviceId = crypto.randomUUID().slice(0, 8);
    await store.setMeta('deviceId', deviceId);
  }
  applyTheme();
  await seedDefaults();
  await registerDevice();
  await purgeTrash(false);
  bindUi();
  setMoneyHidden(!!getView().privacyStart);
  setPrivacy(!!getView().privacyStart);
  fillCfgForm();
  await render();
  await showIdleStatus();
  if (isConfigured()) doSync(false);
  else await showTab('ajustes');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init().catch((e) => setStatus('No se pudo iniciar: ' + (e.message || e), 'err'));
