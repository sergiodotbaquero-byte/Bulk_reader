// Copia el worker y el núcleo WASM de tesseract.js a public/tesseract para servirlos
// desde el mismo origen (sin depender de un CDN) y poder cachearlos en la PWA.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'tesseract');
const workerSrc = join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js');
const coreDir = join(root, 'node_modules', 'tesseract.js-core');

if (!existsSync(workerSrc) || !existsSync(coreDir)) {
  console.warn('[copy-tesseract] no encuentro tesseract.js en node_modules; corre npm install primero.');
  process.exit(0);
}

mkdirSync(join(out, 'core'), { recursive: true });
copyFileSync(workerSrc, join(out, 'worker.min.js'));
let copied = 1;
// El worker solo carga `tesseract-core*.wasm.js` (que a su vez pide el `.wasm` vecino);
// los `tesseract-core*.js` sin ".wasm" son para Node y no hace falta servirlos.
for (const f of readdirSync(coreDir)) {
  if (f.startsWith('tesseract-core') && /\.wasm(\.js)?$/.test(f)) {
    copyFileSync(join(coreDir, f), join(out, 'core', f));
    copied++;
  }
}
// Datos del idioma inglés (modelo LSTM "best_int": buena precisión, ~4 MB comprimido).
const langDir = join(root, 'node_modules', '@tesseract.js-data', 'eng');
const langCandidates = ['4.0.0_best_int', '4.0.0_fast', '4.0.0'].map((v) => join(langDir, v, 'eng.traineddata.gz'));
const langSrc = langCandidates.find((p) => existsSync(p));
if (langSrc) {
  mkdirSync(join(out, 'lang'), { recursive: true });
  copyFileSync(langSrc, join(out, 'lang', 'eng.traineddata.gz'));
  copied++;
} else {
  console.warn('[copy-tesseract] no encuentro @tesseract.js-data/eng; el OCR intentará bajar el idioma del CDN.');
}
console.log(`[copy-tesseract] ${copied} archivos copiados a public/tesseract`);
