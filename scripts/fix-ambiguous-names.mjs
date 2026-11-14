/**
 * Limpia los nombres impresos ambiguos de public/names/<lang>.json.
 *
 * Un mismo nombre impreso puede apuntar a dos cartas distintas por dos motivos:
 *  - traducción legítima repetida ("Agotamiento" es Attrition y Exhaustion, las dos con muchas
 *    impresiones): se conservan las dos y el índice las ofrece como alternativas;
 *  - error de datos de Scryfall (una sola impresión de Plains con printed_name "Isla", frente a
 *    cientos que dicen "Llanura"): se descarta.
 * Para distinguirlos hace falta saber cuántas impresiones respaldan cada lectura, así que se
 * consulta solo las cartas implicadas (un par de docenas), no el catálogo entero.
 *
 *   node scripts/fix-ambiguous-names.mjs            → es y pt
 *   node scripts/fix-ambiguous-names.mjs es
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public', 'names');
const langs = process.argv.slice(2).length ? process.argv.slice(2) : ['es', 'pt'];
const API = 'https://api.scryfall.com';
const GAP_MS = Number(process.env.SCRYFALL_GAP_MS) || 250;
/** Una lectura con tan pocas impresiones, y tan pocas frente a la otra, es un error de datos. */
const RARE_MAX = 2;
const RATIO = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempt = 0) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'mtg-bulk-scanner-build/0.1' },
  });
  if (res.status === 404) return { data: [], has_more: false };
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

/** Nombres impresos de una carta (incluye las caras de las dobles). */
function printedNames(card) {
  const out = [];
  if (card.printed_name) out.push(card.printed_name.trim());
  if (card.card_faces) for (const f of card.card_faces) if (f.printed_name) out.push(f.printed_name.trim());
  return out;
}

/** Cuántas impresiones en ese idioma usan cada nombre impreso, para una carta concreta. */
async function printedCounts(english, lang) {
  const counts = new Map();
  let url = `${API}/cards/search?q=${encodeURIComponent(`!"${english.replace(/"/g, '')}" lang:${lang}`)}&unique=prints`;
  while (url) {
    const t0 = Date.now();
    const page = await getJson(url);
    for (const card of page.data) {
      for (const p of printedNames(card)) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    url = page.has_more ? page.next_page : null;
    const wait = GAP_MS - (Date.now() - t0);
    if (url && wait > 0) await sleep(wait);
  }
  return counts;
}

async function fixLang(lang) {
  const file = resolve(outDir, `${lang}.json`);
  const data = JSON.parse(await readFile(file, 'utf8'));
  const byPrinted = new Map();
  for (const [printed, english] of data.pairs) {
    const arr = byPrinted.get(printed) ?? [];
    if (!arr.includes(english)) arr.push(english);
    byPrinted.set(printed, arr);
  }
  const ambiguous = [...byPrinted.entries()].filter(([, v]) => v.length > 1);
  console.log(`[${lang}] ${ambiguous.length} nombres impresos ambiguos de ${byPrinted.size}`);
  if (!ambiguous.length) return;

  const cache = new Map(); // english -> Map(printed -> count)
  const countFor = async (english) => {
    let c = cache.get(english);
    if (!c) {
      c = await printedCounts(english, lang);
      cache.set(english, c);
      await sleep(GAP_MS);
    }
    return c;
  };

  const drop = new Set(); // "printed\u0000english"
  for (const [printed, englishNames] of ambiguous) {
    const counts = [];
    for (const english of englishNames) counts.push({ english, n: (await countFor(english)).get(printed) ?? 0 });
    const max = Math.max(...counts.map((c) => c.n));
    for (const c of counts) {
      if (c.n <= RARE_MAX && c.n * RATIO < max) {
        drop.add(`${printed}\u0000${c.english}`);
        console.log(`  descartado: "${printed}" → ${c.english} (${c.n} impresión(es) frente a ${max})`);
      }
    }
    if (!counts.some((c) => drop.has(`${printed}\u0000${c.english}`))) {
      console.log(`  se conserva: "${printed}" → ${counts.map((c) => `${c.english} (${c.n})`).join(', ')}`);
    }
  }

  if (!drop.size) {
    console.log(`[${lang}] nada que descartar`);
    return;
  }
  data.pairs = data.pairs.filter(([p, e]) => !drop.has(`${p}\u0000${e}`));
  data.fixedAt = new Date().toISOString().slice(0, 10);
  await writeFile(file, JSON.stringify(data));
  console.log(`[${lang}] ${drop.size} pares descartados; quedan ${data.pairs.length} → ${file}`);
}

for (const lang of langs) await fixLang(lang);
