/**
 * Genera public/names/<lang>.json con los nombres IMPRESOS de las cartas en otros idiomas
 * (español, portugués…) y su nombre oficial en inglés, para que el OCR reconozca cartas
 * que no están en inglés. Scryfall no tiene un catálogo de nombres por idioma, así que se
 * recorre la búsqueda `lang:xx unique:prints` (unas 300 páginas para español).
 *
 *   node scripts/build-names.mjs            → es y pt
 *   node scripts/build-names.mjs es pt fr   → los idiomas que se pidan
 *
 * Tarda unos minutos (Scryfall pide ~100 ms entre peticiones). El resultado se versiona con
 * la app; en tiempo de ejecución la app completa sola los sets publicados después de esta fecha.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public', 'names');
const langs = process.argv.slice(2).length ? process.argv.slice(2) : ['es', 'pt'];
const API = 'https://api.scryfall.com';
// Scryfall limita a ~10 peticiones/s pero corta ráfagas largas: con 250 ms no devuelve 429.
const GAP_MS = Number(process.env.SCRYFALL_GAP_MS) || 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempt = 0) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'mtg-bulk-scanner-build/0.1' },
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`Scryfall respondió ${res.status} en ${url}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    console.warn(`  ${res.status}; reintento en ${wait} ms`);
    await sleep(wait);
    return getJson(url, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.details ?? `Scryfall respondió ${res.status} en ${url}`);
  }
  return res.json();
}

/** Pares (nombre impreso, nombre en inglés) de una carta; omite lo que coincide con el inglés. */
function pairsOf(card) {
  const out = [];
  const push = (printed, english) => {
    if (!printed || !english) return;
    const p = printed.trim();
    if (!p || p === english) return;
    out.push([p, english]);
  };
  push(card.printed_name, card.name);
  if (card.card_faces) {
    for (const face of card.card_faces) push(face.printed_name, card.name);
  }
  return out;
}

async function buildLang(lang) {
  const pairs = new Map(); // "printed\u0000english" -> [printed, english]

  const sets = new Set();
  let url = `${API}/cards/search?q=${encodeURIComponent(`lang:${lang}`)}&unique=prints&order=set`;
  let page = 0;
  let total = 0;
  let cards = 0;
  while (url) {
    const t0 = Date.now();
    const list = await getJson(url);
    page++;
    total = list.total_cards ?? total;
    for (const card of list.data) {
      cards++;
      sets.add(card.set);
      for (const [p, e] of pairsOf(card)) pairs.set(`${p}\u0000${e}`, [p, e]);
    }
    if (page % 20 === 0 || !list.has_more) {
      console.log(`  [${lang}] página ${page}: ${cards}/${total} impresiones, ${pairs.size} nombres`);
    }
    url = list.has_more ? list.next_page : null;
    const wait = GAP_MS - (Date.now() - t0);
    if (url && wait > 0) await sleep(wait);
  }
  const list = [...pairs.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const data = {
    lang,
    builtAt: new Date().toISOString().slice(0, 10),
    source: 'https://api.scryfall.com/cards/search?q=lang:' + lang,
    printings: cards,
    sets: [...sets].sort(),
    pairs: list,
  };
  await mkdir(outDir, { recursive: true });
  const file = resolve(outDir, `${lang}.json`);
  await writeFile(file, JSON.stringify(data));
  console.log(`[${lang}] ${list.length} nombres de ${cards} impresiones en ${sets.size} sets → ${file}`);
}

for (const lang of langs) {
  console.log(`Descargando nombres en "${lang}"…`);
  await buildLang(lang);
}
console.log('Listo. Ahora conviene correr: node scripts/fix-ambiguous-names.mjs ' + langs.join(' '));
