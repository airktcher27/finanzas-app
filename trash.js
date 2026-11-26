// Papelera y versiones (puro, sin navegador).
// Lo eliminado queda como "lápida" (deleted: true) con todos sus datos: así se puede recuperar.
// Tras TRASH_DAYS se le quitan los datos y queda solo la marca de borrado (necesaria para sincronizar).

export const TRASH_DAYS = 30;
export const TRASH_COLS = new Set(['movs', 'cuentas', 'deudas', 'inv', 'metas']);
const BASE = new Set(['col', 'id', 'updatedAt', 'dev', 'deleted']);
const hasContent = (r) => Object.keys(r).some((k) => !BASE.has(k));
const keyOf = (r) => `${r.col}/${r.id}`;

// Grupos recuperables, del más reciente al más viejo: { key, main, items[], deletedAt }.
// Lo que se borró junto (una cuenta con sus movimientos) comparte `trash` y se recupera junto.
export function trashGroups(all, now = Date.now()) {
  const cut = now - TRASH_DAYS * 864e5;
  const groups = new Map();
  for (const r of all) {
    if (!r.deleted || !TRASH_COLS.has(r.col) || !hasContent(r) || r.updatedAt < cut) continue;
    const key = r.trash || keyOf(r);
    let g = groups.get(key);
    if (!g) { g = { key, items: [], deletedAt: 0 }; groups.set(key, g); }
    g.items.push(r);
    g.deletedAt = Math.max(g.deletedAt, r.updatedAt);
  }
  const rank = { cuentas: 0, deudas: 1, metas: 2, inv: 3, movs: 4 };
  for (const g of groups.values()) {
    g.items.sort((a, b) => rank[a.col] - rank[b.col]);
    g.main = g.items[0];
  }
  return [...groups.values()].sort((a, b) => b.deletedAt - a.deletedAt);
}

// Lápidas vencidas (o todas si `all` = true) reducidas a la marca de borrado.
export function purgeable(records, now = Date.now(), everything = false) {
  const cut = now - TRASH_DAYS * 864e5;
  return records
    .filter((r) => r.deleted && TRASH_COLS.has(r.col) && hasContent(r) && (everything || r.updatedAt < cut))
    .map((r) => ({ col: r.col, id: r.id, updatedAt: r.updatedAt, dev: r.dev, deleted: true }));
}

// Lo que no se toca al restaurar una versión: datos internos de cada dispositivo y de la limpieza.
const SKIP = (r) => r.col === 'dispositivos' || (r.col === 'config' && r.id === 'compactacion');

// Cambios para dejar los datos como en una versión anterior (se guardan con fecha de ahora, así
// ganan en la sincronización): todo lo de esa versión tal cual, y lo creado después, eliminado.
export function restorePlan(current, version) {
  const inVersion = new Set(version.map(keyOf));
  const out = version.filter((r) => !SKIP(r)).map((r) => ({ ...r }));
  for (const r of current) {
    if (SKIP(r) || r.deleted || inVersion.has(keyOf(r))) continue;
    out.push({ ...r, deleted: true });
  }
  return out;
}

// Resumen de una versión para mostrar antes de restaurar.
export function versionSummary(records) {
  const live = (c) => records.filter((r) => r.col === c && !r.deleted).length;
  return { movs: live('movs'), cuentas: live('cuentas'), deudas: live('deudas'), inv: live('inv'), metas: live('metas') };
}
