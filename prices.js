// Precios de acciones/ETF con Twelve Data (plan gratis: 8 consultas por minuto, 800 al día).
// La clave vive solo en este dispositivo. Si la consulta falla (sin conexión, clave mala,
// el navegador bloquea la petición), la app sigue funcionando con precios escritos a mano.

export const MAX_PER_CALL = 8;

const toMinor = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100 * 1e4) / 1e4 : null; // centavos, con decimales
};

// Interpreta la respuesta de /price. Con un solo símbolo llega {"price":"200.99"};
// con varios, {"VOO":{"price":"200.99"},"VXUS":{...}}; los errores llegan como
// {"code":401,"message":"...","status":"error"} (arriba o por símbolo).
export function parsePrices(json, symbols) {
  const prices = {};
  const errors = {};
  let fatal = null;
  if (!json || typeof json !== 'object') return { prices, errors, fatal: 'Respuesta inesperada del servicio de precios.' };
  const msgOf = (j) => {
    if (j.code === 401 || j.code === 403) return 'La clave de Twelve Data no es válida.';
    if (j.code === 429) return 'Llegaste al límite gratuito de consultas; espera un minuto.';
    return j.message ? String(j.message) : 'Error del servicio de precios.';
  };
  if (json.status === 'error' && !symbols.some((s) => json[s])) return { prices, errors, fatal: msgOf(json) };
  if (symbols.length === 1 && 'price' in json) {
    const p = toMinor(json.price);
    if (p) prices[symbols[0]] = p; else errors[symbols[0]] = 'Sin precio';
    return { prices, errors, fatal };
  }
  for (const s of symbols) {
    const j = json[s];
    if (!j) { errors[s] = 'Sin respuesta'; continue; }
    if (j.status === 'error') { errors[s] = msgOf(j); continue; }
    const p = toMinor(j.price);
    if (p) prices[s] = p; else errors[s] = 'Sin precio';
  }
  return { prices, errors, fatal };
}

// Devuelve { prices, errors, skipped, fatal }. `fetchImpl` se inyecta en las pruebas.
export async function fetchPrices(symbols, apiKey, fetchImpl = fetch) {
  const list = [...new Set(symbols)].filter(Boolean);
  const batch = list.slice(0, MAX_PER_CALL);
  const skipped = list.slice(MAX_PER_CALL);
  if (!batch.length) return { prices: {}, errors: {}, skipped, fatal: null };
  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(batch.join(','))}&apikey=${encodeURIComponent(apiKey)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    let json = null;
    try { json = await res.json(); } catch { /* cuerpo no es JSON */ }
    if (!json) return { prices: {}, errors: {}, skipped, fatal: `El servicio de precios respondió ${res.status}.` };
    return { ...parsePrices(json, batch), skipped };
  } catch (e) {
    const timeout = e && e.name === 'AbortError';
    return {
      prices: {}, errors: {}, skipped, network: true,
      fatal: timeout
        ? 'El servicio de precios tardó demasiado.'
        : 'No se pudo consultar el precio (sin conexión o el navegador bloqueó la consulta). Puedes escribirlo a mano.',
    };
  } finally {
    clearTimeout(timer);
  }
}
