/**
 * Ayudas de depuración (solo si en la consola se pone `window.__mtgDebug = true`):
 * muestra en pantalla los recortes que se le pasan al OCR.
 */
export function debugEnabled(): boolean {
  return Boolean((window as unknown as { __mtgDebug?: boolean }).__mtgDebug);
}

export function debugShow(canvas: HTMLCanvasElement, label: string): void {
  if (!debugEnabled()) return;
  let host = document.getElementById('mtg-debug');
  if (!host) {
    host = document.createElement('div');
    host.id = 'mtg-debug';
    host.style.cssText =
      'position:fixed;left:8px;top:64px;z-index:999;display:grid;gap:4px;background:rgba(0,0,0,.7);padding:6px;max-width:70vw;pointer-events:none';
    document.body.appendChild(host);
  }
  const img = document.createElement('img');
  img.src = canvas.toDataURL();
  img.alt = label;
  img.title = label;
  img.style.cssText = 'max-width:100%;border:1px solid #f0a23a;background:#fff';
  host.appendChild(img);
  while (host.childElementCount > 4) host.firstElementChild?.remove();
}
