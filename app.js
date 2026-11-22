import { openStore } from './store.js';
import { createGithub } from './github.js';
import { runSync, exportEncrypted, importEncrypted } from './sync.js';
import { SyncError } from './errors.js';
import { parseAmount, formatMoney, toInput, CURRENCIES } from './money.js';
import { live, accountBalances, filterMovs, monthTotals, netSummary, todayStr, monthOf, shiftMonth } from './ledger.js';
import { DEFAULT_CATEGORIES, SUGGESTED_ACCOUNTS, ACCOUNT_TYPES } from './defaults.js';

const VERSION = '0.2.0 (Fase 1)';
const CFG_KEY = 'finanzas.cfg';
const $ = (s) => document.querySelector(s);

let store;
let deviceId;
let syncing = false;
let syncTimer = null;
const ui = { tab: 'resumen', month: monthOf(todayStr()), filterAccount: '', data: null };

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
async function seedDefaults() {
  if (await store.getMeta('seededCats')) return;
  const all = await store.getAllRecords();
  const have = new Set(all.filter((r) => r.col === 'categorias').map((r) => r.id));
  const recs = DEFAULT_CATEGORIES.filter((c) => !have.has(c.id)).map((c, i) => ({
    col: 'categorias', id: c.id, name: c.name, kind: c.kind, archived: false, deleted: false, order: i, updatedAt: 0, dev: '',
  }));
  await store.putRecords(recs);
  await store.setMeta('seededCats', true);
}

async function loadData() {
  const all = await store.getAllRecords();
  const accounts = live(all, 'cuentas').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const cats = live(all, 'categorias').sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name, 'es'));
  const movs = live(all, 'movs');
  return {
    accounts,
    cats,
    movs,
    balances: accountBalances(accounts, movs),
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

// ---------- Vistas ----------
async function render() {
  ui.data = await loadData();
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  for (const t of ['resumen', 'movs', 'ajustes']) $(`#tab-${t}`).hidden = ui.tab !== t;
  $('#fab').hidden = ui.tab === 'ajustes';
  if (ui.tab === 'resumen') renderResumen(ui.data);
  else if (ui.tab === 'movs') renderMovs(ui.data);
  else renderCategories(ui.data);
}

function showTab(name) {
  ui.tab = name;
  return render();
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
  return h('button', { type: 'button', class: 'item' + (a.archived ? ' archived' : ''), onclick: () => openAccountForm(a) },
    h('div', { class: 'main' }, h('div', { class: 'title', text: a.name }), h('div', { class: 'sub', text: sub })),
    h('div', { class: 'amt ' + cls, text: amt }));
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
  const net = netSummary(d.accounts, d.balances);
  const totals = monthTotals(d.movs, d.accById, monthOf(todayStr()));
  const cards = h('div', { class: 'cards' });
  for (const cur of Object.keys(net)) {
    const n = net[cur];
    const t = totals[cur] || { ingresos: 0, gastos: 0 };
    cards.append(h('div', { class: 'card' },
      h('div', { class: 'cur', text: `Neto · ${CURRENCIES[cur] ? CURRENCIES[cur].label : cur}` }),
      h('div', { class: 'big', text: formatMoney(n.net, cur) }),
      h('div', { class: 'line' }, h('span', { text: 'Disponible' }), h('span', { text: formatMoney(n.assets, cur) })),
      n.cards !== 0 && h('div', { class: 'line' }, h('span', { text: 'Tarjetas' }), h('span', { text: formatMoney(n.cards, cur) })),
      h('div', { class: 'line' }, h('span', { text: 'Ingresos este mes' }), h('span', { text: formatMoney(t.ingresos, cur) })),
      h('div', { class: 'line' }, h('span', { text: 'Gastos este mes' }), h('span', { text: formatMoney(t.gastos, cur) }))));
  }
  root.append(cards);

  const active = d.accounts.filter((a) => !a.archived);
  const archived = d.accounts.filter((a) => a.archived);
  root.append(h('div', { class: 'section-title', text: 'Cuentas' }), h('div', { class: 'list' }, active.map((a) => accountRow(a, d))));
  if (archived.length) {
    root.append(h('div', { class: 'section-title', text: 'Archivadas' }), h('div', { class: 'list' }, archived.map((a) => accountRow(a, d))));
  }
  root.append(h('div', { class: 'row wrap', style: 'margin-top:14px' },
    h('button', { class: 'btn', type: 'button', onclick: () => openAccountForm(), text: '＋ Nueva cuenta' })));
}

function movRow(m, d) {
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
    sub = [m.note, from ? from.name : null].filter(Boolean).join(' · ');
    amt = (m.kind === 'ingreso' ? '+' : '−') + formatMoney(m.amount, fromCur);
    cls = m.kind === 'ingreso' ? 'pos' : 'neg';
  }
  return h('button', { type: 'button', class: 'item', onclick: () => openMovForm(m) },
    h('div', { class: 'main' }, h('div', { class: 'title', text: title }), h('div', { class: 'sub', text: sub })),
    h('div', { class: 'amt ' + cls }, amt, small && h('small', { text: small })));
}

function renderMovs(d) {
  const root = $('#movs-body');
  root.replaceChildren();
  const bar = h('div', { class: 'monthbar' },
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Mes anterior', text: '◀', onclick: () => { ui.month = shiftMonth(ui.month, -1); render(); } }),
    h('strong', { text: monthLabel(ui.month) }),
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Mes siguiente', text: '▶', onclick: () => { ui.month = shiftMonth(ui.month, 1); render(); } }));
  const sel = h('select', { 'aria-label': 'Filtrar por cuenta', onchange: (e) => { ui.filterAccount = e.target.value; render(); } },
    opt('', 'Todas las cuentas', !ui.filterAccount),
    d.accounts.map((a) => opt(a.id, a.name + (a.archived ? ' (archivada)' : ''), ui.filterAccount === a.id)));
  root.append(bar, sel);

  const totals = monthTotals(d.movs, d.accById, ui.month, ui.filterAccount);
  const parts = Object.entries(totals).map(([cur, t]) => `${cur}: ingresos ${formatMoney(t.ingresos, cur)} · gastos ${formatMoney(t.gastos, cur)}`);
  root.append(h('p', { class: 'totals', text: parts.join('   |   ') || 'Sin ingresos ni gastos este mes.' }));

  const list = filterMovs(d.movs, { month: ui.month, accountId: ui.filterAccount });
  if (!list.length) {
    root.append(h('div', { class: 'empty' },
      h('p', { text: 'No hay movimientos en este mes.' }),
      h('button', { class: 'btn primary', type: 'button', onclick: () => openMovForm(), text: '＋ Añadir movimiento' })));
    return;
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
    ul.append(movRow(m, d));
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

async function openMovForm(existing) {
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
      };

  const body = h('div');
  const err = h('p', { class: 'error', hidden: true });
  const read = () => {
    const f = body.querySelector('form');
    if (!f) return;
    for (const k of ['amount', 'toAmount', 'accountId', 'toAccountId', 'categoryId', 'date', 'note']) {
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

function openAccountForm(existing) {
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
        archived: !!existing.archived,
      }
    : { name: '', type: 'debito', currency: 'COP', opening: '', limit: '', archived: false };

  const body = h('div');
  const err = h('p', { class: 'error', hidden: true });
  const read = () => {
    const f = body.querySelector('form');
    if (!f) return;
    for (const k of ['name', 'type', 'currency', 'opening', 'limit']) if (f.elements[k]) s[k] = f.elements[k].value;
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
      existing && h('label', { class: 'check' },
        h('input', { type: 'checkbox', name: 'archived', checked: s.archived }), 'Archivada (la oculta del resumen y de los formularios)'),
    ];
    const buttons = h('div', { class: 'row end wrap' },
      h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeSheet }),
      h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' }));
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
async function doSync(interactive) {
  if (syncing) return;
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
    const cfg = loadCfg();
    const gh = createGithub({
      owner: cfg.owner,
      repo: cfg.repo,
      branch: cfg.branch || 'main',
      path: cfg.path || 'datos.enc.json',
      token: cfg.token,
    });
    const getPassphrase = async ({ isNew }) => {
      if (!interactive) throw new SyncError('NEEDS_PASSPHRASE');
      const p = await askPassphrase({ isNew });
      if (!p) throw new SyncError('CANCELLED');
      return p;
    };
    const res = await runSync({ store, gh, getPassphrase });
    await render();
    setStatus(`Sincronizado: ${res.pulled} cambio(s) recibido(s)${res.pushed ? ', cambios subidos' : ''}.`, 'ok');
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
  $('#device-info').textContent = `ID del dispositivo: ${deviceId} · Versión ${VERSION}`;
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
  $('#fab').addEventListener('click', () => openMovForm());
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
  await seedDefaults();
  bindUi();
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
