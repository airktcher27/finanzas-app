// Prueba en Node: dos "dispositivos" y un GitHub falso en memoria.
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import assert from 'node:assert/strict';
import { runSync, exportEncrypted, importEncrypted, canCompress } from './comun/sync.js';
import { createGithub, pickVersions } from './comun/github.js';
import { encryptJson, decryptJson, deriveKey, newSalt } from './comun/crypto.js';
import { SyncError } from './comun/errors.js';

function memStore() {
  const recs = new Map();
  const meta = new Map();
  return {
    async getAllRecords() { return [...recs.values()].map((r) => ({ ...r })); },
    async putRecords(l) { for (const r of l) recs.set(`${r.col}/${r.id}`, { ...r }); },
    async getMeta(k) { return meta.get(k); },
    async setMeta(k, v) { meta.set(k, v); },
    async delMeta(k) { meta.delete(k); },
  };
}

const resp = (status, obj) => ({ status, ok: status < 400, json: async () => obj, text: async () => JSON.stringify(obj) });

function fakeGithub() {
  const state = { file: null, n: 0, putCalls: 0, failNextPutWithConflict: false };
  state.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    if (u.pathname === '/repos/o/r/contents/datos.enc.json') {
      if (method === 'GET') {
        if (!state.file) return resp(404, { message: 'Not Found' });
        return resp(200, { sha: state.file.sha, encoding: 'base64', content: state.file.content.replace(/(.{60})/g, '$1\n') });
      }
      if (method === 'PUT') {
        state.putCalls++;
        const body = JSON.parse(opts.body);
        if (state.failNextPutWithConflict) { state.failNextPutWithConflict = false; return resp(409, { message: 'sha does not match' }); }
        if (state.file && body.sha !== state.file.sha) return resp(409, { message: 'sha does not match' });
        if (!state.file && body.sha) return resp(422, { message: 'invalid sha' });
        state.file = { sha: 'sha' + ++state.n, content: body.content };
        return resp(200, {});
      }
    }
    if (u.pathname === '/repos/o/r') return resp(200, {});
    return resp(404, { message: 'Not Found' });
  };
  return state;
}

const gh = fakeGithub();
const mk = (dev) => ({
  dev,
  store: memStore(),
  gh: createGithub({ owner: 'o', repo: 'r', token: 't', fetchFn: gh.fetch }),
});
const rec = (dev, id, text, t, extra = {}) => ({ col: 'notas', id, text, updatedAt: t, dev, deleted: false, ...extra });
const pass = (p) => async () => p;
const visible = async (d) => (await d.store.getAllRecords()).filter((r) => !r.deleted).map((r) => r.text).sort();
const sync = (d, p = 'clave-secreta') => runSync({ store: d.store, gh: d.gh, getPassphrase: pass(p), retryDelay: 1 });

let n = 0;
const ok = (name) => console.log(`  ok ${++n}. ${name}`);

const A = mk('devA');
const B = mk('devB');

// 1. A crea datos y sincroniza (vault nuevo)
await A.store.putRecords([rec('devA', '1', 'leche', 100), rec('devA', '2', 'pan', 100)]);
let r = await sync(A);
assert.equal(r.pushed, true);
assert.ok(gh.file);
ok('A crea el archivo remoto');

// 2. El archivo remoto no contiene texto en claro
const raw = Buffer.from(gh.file.content, 'base64').toString('utf8');
assert.ok(!raw.includes('leche') && !raw.includes('pan'));
const parsed = JSON.parse(raw);
assert.ok(parsed.salt && parsed.iv && parsed.data && parsed.iter);
ok('el archivo remoto está cifrado');

// 3. B (dispositivo nuevo) con contraseña incorrecta falla
await assert.rejects(() => sync(B, 'otra'), (e) => e instanceof SyncError && e.code === 'WRONG_KEY');
assert.equal(await B.store.getMeta('syncKey'), undefined);
ok('contraseña incorrecta es rechazada y no se guarda la clave');

// 4. B con la contraseña correcta recibe los datos
r = await sync(B);
assert.deepEqual(await visible(B), ['leche', 'pan']);
assert.equal(r.pushed, false);
ok('B recibe los datos de A');

// 5. Segunda sincronización de B no pide contraseña (clave en caché) ni sube nada
let asked = false;
r = await runSync({ store: B.store, gh: B.gh, getPassphrase: async () => { asked = true; return 'x'; } });
assert.equal(asked, false);
assert.equal(r.pushed, false);
const putsBefore = gh.putCalls;
ok('clave en caché: no pide contraseña y no sube si no hay cambios');

// 6. Cambios en ambos lados: B edita "pan", borra "leche"; A agrega "arroz"
await B.store.putRecords([rec('devB', '2', 'pan integral', 200), rec('devB', '1', 'leche', 200, { deleted: true })]);
await A.store.putRecords([rec('devA', '3', 'arroz', 150)]);
await sync(B);
await sync(A);
await sync(B);
assert.deepEqual(await visible(A), ['arroz', 'pan integral']);
assert.deepEqual(await visible(B), ['arroz', 'pan integral']);
ok('ediciones, borrados y altas convergen en ambos dispositivos');

// 7. Conflicto: la misma nota editada en ambos; gana la más reciente
await A.store.putRecords([rec('devA', '3', 'arroz A', 300)]);
await B.store.putRecords([rec('devB', '3', 'arroz B', 400)]);
await sync(A);
await sync(B);
await sync(A);
assert.deepEqual(await visible(A), await visible(B));
assert.ok((await visible(A)).includes('arroz B'));
ok('conflicto en el mismo registro: gana el más reciente');

// 8. Conflicto de versión en el PUT: reintenta y termina bien
await A.store.putRecords([rec('devA', '4', 'huevos', 500)]);
gh.failNextPutWithConflict = true;
r = await sync(A);
assert.equal(r.pushed, true);
await sync(B);
assert.ok((await visible(B)).includes('huevos'));
ok('un 409 en la subida se reintenta solo');

// 9. Exportar / importar respaldo cifrado
const backup = await exportEncrypted(A.store, 'otra-clave');
assert.ok(!backup.includes('huevos'));
const C = mk('devC');
await assert.rejects(() => importEncrypted(C.store, backup, 'mala'), (e) => e.code === 'WRONG_KEY');
const imported = await importEncrypted(C.store, backup, 'otra-clave');
assert.ok(imported > 0);
assert.deepEqual(await visible(C), await visible(A));
await assert.rejects(() => importEncrypted(C.store, 'no es json', 'x'), (e) => e.code === 'BAD_FILE');
ok('respaldo cifrado: exporta, rechaza clave mala e importa');

// 10. Archivo remoto vacío de cambios: sin subida innecesaria
const before = gh.putCalls;
await sync(A);
await sync(B);
assert.equal(gh.putCalls, before);
ok('sin cambios no se hace ninguna subida');

// 11. Compresión: ida y vuelta, y mucho más pequeño
{
  const salt = newSalt();
  const key = await deriveKey('k', salt, 1000);
  const records = Array.from({ length: 400 }, (_, i) => ({ col: 'movs', id: 'id-' + i, kind: 'gasto', amount: i * 100, note: 'Almuerzo', updatedAt: i, dev: 'd' }));
  const plain = await encryptJson(key, salt, 1000, { records });
  const comp = await encryptJson(key, salt, 1000, { records }, { compress: true });
  assert.equal(comp.v, 2);
  assert.equal(comp.z, 'gzip');
  assert.ok(comp.data.length * 4 < plain.data.length, `comprimido ${comp.data.length} vs ${plain.data.length}`);
  assert.deepEqual((await decryptJson(key, comp)).records, records);
  assert.deepEqual((await decryptJson(key, plain)).records, records);
  await assert.rejects(() => decryptJson(key, { ...comp, z: 'zstd' }), (e) => e.code === 'BAD_FILE');
  ok('compresión antes de cifrar: lee v1 y v2, y v2 es >4 veces más pequeño');
}

// 12. Solo se comprime cuando todos los dispositivos recientes lo entienden
{
  const now = Date.parse('2026-11-26T12:00:00Z');
  const day = 864e5;
  const base = [
    { col: 'movs', id: '1', dev: 'pc', updatedAt: now - day },
    { col: 'movs', id: '2', dev: 'cel', updatedAt: now - 2 * day },
    { col: 'dispositivos', id: 'pc', caps: ['gz'], dev: 'pc', updatedAt: now - day },
  ];
  assert.equal(canCompress(base, now), false);   // el celular aún no se actualiza
  const both = [...base, { col: 'dispositivos', id: 'cel', caps: ['gz'], dev: 'cel', updatedAt: now }];
  assert.equal(canCompress(both, now), true);
  const oldCel = [base[0], base[2], { col: 'movs', id: '2', dev: 'cel', updatedAt: now - 90 * day }];
  assert.equal(canCompress(oldCel, now), true);   // el celular no escribe hace 90 días
  ok('formato comprimido solo cuando todos los dispositivos recientes están actualizados');

  // Sincronización real: A y B registran que entienden gzip → el archivo pasa a v2 y ambos lo leen
  const gz = fakeGithub();
  const mk2 = (dev) => ({ dev, store: memStore(), gh: createGithub({ owner: 'o', repo: 'r', token: 't', fetchFn: gz.fetch }) });
  const X = mk2('x'), Y = mk2('y');
  const t0 = Date.now();
  await X.store.putRecords([rec('x', 'n1', 'uno', t0), { col: 'dispositivos', id: 'x', caps: ['gz'], dev: 'x', updatedAt: t0 }]);
  await sync(X);
  await Y.store.putRecords([rec('y', 'n2', 'dos', t0 + 1)]);
  await sync(Y);
  const fileOf = () => JSON.parse(Buffer.from(gz.file.content, 'base64').toString('utf8'));
  assert.equal(fileOf().v, 1, 'Y sin registrarse → sigue v1');
  await Y.store.putRecords([{ col: 'dispositivos', id: 'y', caps: ['gz'], dev: 'y', updatedAt: t0 + 2 }]);
  await sync(Y);
  assert.equal(fileOf().v, 2);
  await sync(X);
  assert.deepEqual((await visible(X)).filter(Boolean), ['dos', 'uno']);
  ok('sincronizando: pasa a v2 cuando el segundo dispositivo se actualiza, y ambos lo leen');
}

// 13. Qué versiones conservar al limpiar el historial
{
  const now = Date.parse('2026-11-26T12:00:00Z');
  const H = 36e5;
  const mkc = (hoursAgo) => ({ sha: 'c' + hoursAgo, date: new Date(now - hoursAgo * H).toISOString() });
  // del más nuevo al más viejo: 3 hoy, 2 ayer, 3 hace 10 días (mismo día), 2 hace 200 días
  const list = [1, 2, 3, 30, 31, 240, 241, 242, 4800, 4801].map(mkc);
  const keep = pickVersions(list, now, 90, 2).map((c) => c.sha);
  assert.deepEqual(keep, ['c1', 'c2', 'c3', 'c30', 'c31', 'c240']);
  // sin actividad en 200 días: se conserva al menos la última
  assert.deepEqual(pickVersions([mkc(4800), mkc(4801)], now).map((c) => c.sha), ['c4800']);
  ok('limpieza: todas las de 2 días, una por día hasta 90 días y nada más viejo (siempre la última)');
}

// 14. Limpieza del historial contra un GitHub falso
{
  const now = Date.parse('2026-11-26T12:00:00Z');
  const commits = new Map();
  let head = null;
  const add = (sha, parent, hoursAgo, tree) => {
    const d = new Date(now - hoursAgo * 36e5).toISOString();
    commits.set(sha, { sha, parent, tree, message: 'sync', date: d });
    head = sha;
  };
  add('a', null, 5000, 't-a'); add('b', 'a', 300, 't-b'); add('c', 'b', 299, 't-c'); add('d', 'c', 1, 't-d');
  let n2 = 0;
  let racer = null;
  const posted = [];
  const f = async (url, opts = {}) => {
    const u = new URL(url);
    const m = opts.method || 'GET';
    if (u.pathname === '/repos/o/r/git/refs/heads/main') {
      if (m === 'PATCH') { const b = JSON.parse(opts.body); head = b.sha; return resp(200, {}); }
      const out = resp(200, { object: { sha: head } });
      if (racer) { racer(); racer = null; }
      return out;
    }
    if (u.pathname === '/repos/o/r/commits') {
      const chain = [];
      for (let s = u.searchParams.get('sha'); s; s = commits.get(s).parent) chain.push(commits.get(s));
      const page = Number(u.searchParams.get('page') || 1);
      return resp(200, chain.slice((page - 1) * 100, page * 100).map((c) => ({ sha: c.sha, commit: { tree: { sha: c.tree }, message: c.message, committer: { date: c.date }, author: { date: c.date } } })));
    }
    if (u.pathname === '/repos/o/r/git/commits' && m === 'POST') {
      const b = JSON.parse(opts.body);
      const sha = 'n' + ++n2;
      posted.push(b);
      commits.set(sha, { sha, parent: b.parents[0] || null, tree: b.tree, message: b.message, date: b.committer.date });
      return resp(201, { sha });
    }
    return resp(404, {});
  };
  const g = createGithub({ owner: 'o', repo: 'r', token: 't', fetchFn: f });
  const r1 = await g.compact({ now, delayMs: 0 });
  assert.deepEqual([r1.changed, r1.before, r1.after], [true, 4, 2]);
  const trees = [];
  for (let s = head; s; s = commits.get(s).parent) trees.push(commits.get(s).tree);
  assert.deepEqual(trees, ['t-d', 't-c'], 'quedan la de hoy y la última de hace ~12 días, con su contenido');
  assert.deepEqual(posted.at(0).parents, []);
  const r2 = await g.compact({ now, delayMs: 0 });
  assert.equal(r2.changed, false, 'una segunda limpieza no hace nada');
  // Si otro dispositivo sube algo durante la limpieza, se cancela sin mover la rama
  add('e', head, 0.5, 't-e'); add('f', 'e', 5000, 't-f'); commits.get('f').parent = null; head = 'e'; commits.get('e').parent = 'f';
  const headBefore = head;
  let calls = 0;
  racer = null;
  const origPost = posted.length;
  const g2 = createGithub({ owner: 'o', repo: 'r', token: 't', fetchFn: async (url, opts) => {
    if (new URL(url).pathname.endsWith('/git/refs/heads/main') && (opts?.method || 'GET') === 'GET' && ++calls === 2) add('z', headBefore, 0.1, 't-z');
    return f(url, opts);
  } });
  const r3 = await g2.compact({ now, delayMs: 0 });
  assert.equal(r3.raced, true);
  assert.equal(head, 'z', 'la rama queda con la subida del otro dispositivo');
  assert.ok(posted.length > origPost);
  ok('limpieza en GitHub: recrea solo las versiones conservadas y se cancela si otro dispositivo sube algo');
}

console.log(`\nTodas las pruebas pasaron (${n}).`);
