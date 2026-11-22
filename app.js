import { openStore } from './store.js';
import { createGithub } from './github.js';
import { runSync, exportEncrypted, importEncrypted } from './sync.js';
import { SyncError } from './errors.js';

const VERSION = '0.1.0 (Fase 0)';
const CFG_KEY = 'finanzas.cfg';
const $ = (s) => document.querySelector(s);

let store;
let deviceId;
let syncing = false;
let syncTimer = null;

// ---------- Configuración (se guarda solo en este dispositivo) ----------
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
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
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

// ---------- Datos (fase 0: notas de prueba) ----------
async function saveRecord(rec) {
  rec.updatedAt = Date.now();
  rec.dev = deviceId;
  await store.putRecords([rec]);
  await renderNotes();
  scheduleSync();
}

async function renderNotes() {
  const all = await store.getAllRecords();
  const notes = all.filter((r) => r.col === 'notas' && !r.deleted).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const ul = $('#notes');
  ul.replaceChildren();
  for (const n of notes) {
    const li = document.createElement('li');
    if (n.done) li.className = 'done';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!n.done;
    cb.setAttribute('aria-label', 'Marcar como hecha');
    cb.addEventListener('change', () => saveRecord({ ...n, done: cb.checked }));
    const span = document.createElement('span');
    span.textContent = n.text;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Borrar');
    del.addEventListener('click', () => saveRecord({ ...n, deleted: true }));
    li.append(cb, span, del);
    ul.append(li);
  }
  $('#notes-empty').hidden = notes.length > 0;
}

// ---------- Sincronización ----------
async function doSync(interactive) {
  if (syncing) return;
  if (!isConfigured()) {
    if (interactive) {
      showTab('ajustes');
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
    await renderNotes();
    setStatus(
      `Sincronizado: ${res.pulled} cambio(s) recibido(s)${res.pushed ? ', cambios subidos' : ''}.`,
      'ok'
    );
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

// ---------- Pestañas ----------
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#tab-notas').hidden = name !== 'notas';
  $('#tab-ajustes').hidden = name !== 'ajustes';
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

  $('#note-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('#note-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await saveRecord({ col: 'notas', id: crypto.randomUUID(), text, done: false, deleted: false, createdAt: Date.now() });
  });

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
    showTab('notas');
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
      download(`finanzas-respaldo-${new Date().toISOString().slice(0, 10)}.json`, text);
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
      await renderNotes();
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
  bindUi();
  fillCfgForm();
  await renderNotes();
  await showIdleStatus();
  if (isConfigured()) doSync(false);
  else showTab('ajustes');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init().catch((e) => setStatus('No se pudo iniciar: ' + (e.message || e), 'err'));
