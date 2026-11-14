# MTG Bulk Scanner

PWA para hacer inventario de cartas de **Magic: The Gathering** con la cámara del celular, al estilo ManaBox.
Todo corre en el navegador: la carta se detecta sola en la imagen, el OCR se ejecuta en el dispositivo
(Tesseract.js), los datos y precios salen de la API de [Scryfall](https://scryfall.com/docs/api) y el
inventario se guarda en el propio teléfono (IndexedDB), con exportación a CSV (formato ManaBox y Excel) y
respaldo JSON. Reconoce cartas en **inglés, español y portugués**.

## Correr en el PC

```bash
npm install
npm run dev
```

Abre `https://localhost:5173` y acepta el aviso del certificado autofirmado (la cámara solo funciona en HTTPS).
Sin cámara en el PC puedes probar con el botón de imagen (escanear una foto) o con la pestaña **Buscar**.

## Probar en el celular

1. PC y celular en la misma red Wi-Fi.
2. `npm run dev` imprime una URL **Network** (por ejemplo `https://192.168.1.14:5173`). Ábrela en Chrome (Android)
   o Safari (iPhone), acepta el aviso del certificado y da permiso de cámara.
3. Para tenerla como app: menú del navegador → **Agregar a pantalla de inicio** / **Instalar app**. Con el
   certificado autofirmado del servidor de desarrollo la instalación y el modo sin internet no funcionan; para eso
   hay que publicarla.

## Publicarla (para usarla sin el PC)

`npm run build` deja la app estática en `dist/`. Sirve en cualquier hosting con HTTPS (hace falta para la
cámara y para instalarla). Una vez instalada funciona offline: el motor OCR, los catálogos de nombres y las
imágenes de las cartas se van guardando en caché; solo hace falta internet para consultar cartas nuevas.

El repositorio está conectado a **Netlify** ([github.com/sergiodotbaquero-byte/Bulk_reader](https://github.com/sergiodotbaquero-byte/Bulk_reader)):
cada `git push` a `main` dispara un despliegue. La configuración está en `netlify.toml` y no hay nada que tocar
en el panel: comando `npm run build`, carpeta `dist`, Node 22. Tres detalles que resuelve ese archivo:

- `public/tesseract/` **no está en el repo** (45 MB): lo regenera el script `prebuild` desde `node_modules`
  durante el despliegue.
- Cualquier ruta que no sea un archivo real devuelve `index.html`, porque la app es de una sola página.
- `sw.js` se sirve sin caché y los datos del idioma del OCR sin recomprimir, que si no el motor no los lee.

`dist/tesseract/` pesa unos 45 MB porque incluye todas las variantes del motor (SIMD, sin SIMD…); cada
dispositivo descarga solo la suya (~5 MB) la primera vez. `dist/names/` trae los nombres impresos en español y
portugués (~1 MB por idioma).

## Cómo escanea

1. Muestra la carta completa a la cámara, a la distancia que quieras: la app **detecta el rectángulo de la
   carta** (busca el rectángulo con proporción 63:88 cuyos cuatro lados tengan bordes más fuertes) y dibuja un
   recuadro con esquinas sobre ella. Sirve con la carta descentrada, más cerca o más lejos, y hasta unos 10°
   girada (la endereza antes de leer). El marco blanco del centro es solo una guía: se usa si no se logra
   detectar la carta (por ejemplo si se sale de la imagen).
2. Dentro de la carta ubica el renglón del nombre por el perfil de texto (no por una zona fija), lo lee con OCR y
   lo corrige contra el índice local de nombres: ~35 000 nombres en inglés (catálogo de Scryfall, se actualiza
   a diario) más los nombres impresos en español y portugués. Tolera letras mal leídas y los símbolos de maná.
   Si el primer intento no da un nombre, prueba con la polaridad contraria y binarizado (marcos viejos, letras
   claras sobre fondo texturizado).
3. Lee la esquina inferior (número de coleccionista, código de set e idioma), también ubicada por el perfil de
   texto:
   - Marcos desde 2014 (`168/269 C` · `DOM • EN`) y desde 2025 (`C 0145` · `FIN • SP`): fija la **edición
     exacta** y el idioma → `✓ edición leída`. El código leído se coteja con la lista real de sets de
     Scryfall usando una distancia que abarata las confusiones típicas del OCR (0/O/D, 1/I/L, 5/S, K/X…), así
     que un "DEX" mal leído llega a `DSK` sin gastar peticiones en códigos que no existen. Un código que no
     es idéntico solo confirma la edición si algo más lo respalda: el número de coleccionista, la rareza, el
     tamaño del set impreso, o que la carta exista en una sola edición.
   - Si el nombre no se pudo leer (lands a arte completo con el nombre abajo, idioma que no está en el índice,
     nombre tapado) pero la esquina sí, identifica la carta **solo por la esquina** → `✓ leída por la esquina`
     cuando el texto del título se parece al nombre o la rareza/el total impresos cuadran con la carta.
   - En cartas más viejas casi nunca se puede leer → `? edición sin confirmar`: se muestra la impresión más
     reciente y con **Cambiar edición** la eliges de la lista (ordenada de la más nueva a la más vieja, con precio).
4. Toca **Agregar**. Con el rayo ⚡ activado cada carta reconocida se agrega sola (por defecto solo cuando la
   edición está confirmada; se puede cambiar en Ajustes). Retira la carta y pon la siguiente: al perder la
   carta de vista se reinicia el reconocimiento, así la misma carta no se agrega dos veces por error.

Consejos: buena luz, evitar reflejos (foils), carta plana y ocupando buena parte de la imagen (si la ves
pequeña, la app avisa "acércala más"). Si la cámara lo permite hay **zoom** con pellizco o con el deslizador. En
Ajustes se puede pedir la cámara en **4K**: más detalle para el texto diminuto de la esquina, a cambio de más
carga para el celular.

Las cartas en español o portugués se reconocen por su nombre impreso y quedan marcadas con su idioma
automáticamente (también si la esquina dice `SP` o `PT`); se guardan con el nombre impreso y el nombre en inglés.

## Inventario y exportación

- **Inventario**: cantidades con +/−, búsqueda, filtro por set, orden, totales y valor estimado (precios de
  Scryfall: TCGplayer en USD o Cardmarket en EUR, se elige en Ajustes). Tocar una fila abre el editor
  (acabado, estado, idioma, notas, eliminar).
- **Exportar / importar** (icono de descarga): CSV para ManaBox, CSV para Excel/Sheets, respaldo JSON e
  importación de respaldo (suma cantidades, sirve para juntar el inventario de dos celulares).
- **Deshacer** el último movimiento con la flecha de la cabecera (o desde el aviso que sale al agregar).
- **Buscar**: por nombre en inglés, español o portugués (sugerencias del índice local, funcionan sin red) o por
  set + número, para lo que la cámara no reconozca.
- Los datos viven en el navegador del dispositivo: exporta un respaldo de vez en cuando. Si borras los datos
  del sitio en el navegador, se pierde el inventario.

## Base de datos

El inventario (`inventory_items`) y el historial de escaneos para deshacer (`scan_events`) viven en un
proyecto de **Supabase** (Postgres), no en el navegador: así se ve el mismo inventario desde el celular y
desde el PC. La app no tiene login — usa la clave pública (`anon`/`publishable`) del proyecto directamente,
y las políticas RLS de esas dos tablas están abiertas (`for all to anon using (true)`), así que **cualquiera
con la URL del proyecto puede leer y escribir ese inventario**. Es la configuración correcta para "yo soy el
único que la usa" (la elegida al armar esto); si en algún momento la va a usar más de una persona hace falta
agregar login (Supabase Auth) y políticas por usuario.

`src/lib/supabaseClient.ts` trae la URL y la clave de ese proyecto como valores por defecto, así que funciona
tal cual al clonar o desplegar. Para apuntar a otro proyecto de Supabase (otra cuenta, entorno de pruebas),
definí estas variables antes de `npm run dev` / `npm run build` (o en las variables de entorno de Netlify):

```
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
```

La primera vez que corre con el código nuevo, la app sube sola (una sola vez, sumando cantidades si hace
falta) lo que haya quedado en el IndexedDB viejo de cada dispositivo — el respaldo local no se borra.

## Comandos

| Comando                 | Qué hace                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| `npm run dev`           | Servidor de desarrollo con HTTPS (para el celular por la IP del PC)      |
| `npm run build`         | Chequeo de tipos + build de producción en `dist/`                        |
| `npm run preview`       | Sirve `dist/` por HTTP en `http://localhost:4173`                        |
| `npm run preview:https` | Igual pero con HTTPS (probar el build desde el celular)                  |
| `npm run typecheck`     | Solo TypeScript                                                          |
| `npm run names`         | Regenera `public/names/{es,pt}.json` desde Scryfall (ver abajo)          |
| `npm run names:fix`     | Solo la limpieza de nombres ambiguos (rápida, no re-descarga)            |
| `npm run icons`         | Regenera los iconos PNG (necesita Python + Pillow)                       |

## Nombres en español y portugués

Scryfall no tiene un catálogo de nombres por idioma, así que `scripts/build-names.mjs` recorre la búsqueda
`lang:es` / `lang:pt` (todas las impresiones) y guarda los pares *nombre impreso → nombre en inglés* en
`public/names/<lang>.json`. Tarda unos 25 minutos por idioma y Scryfall limita las ráfagas: el script espera
250 ms entre peticiones (`SCRYFALL_GAP_MS` para cambiarlo) y respeta `Retry-After`.

Después, `scripts/fix-ambiguous-names.mjs` (incluido en `npm run names`, o suelto con `npm run names:fix`)
revisa los nombres impresos que apuntan a dos cartas distintas: 31 en español y 77 en portugués. Consulta
cuántas impresiones respaldan cada lectura (solo de las cartas implicadas, así que termina en minutos) y
descarta las que sean claramente un error de datos: una o dos impresiones frente a diez veces más de la otra
lectura. En la revisión del 2026-11-14 **no hubo ninguna que descartar**: todas resultaron traducciones
legítimas repetidas, como "Agotamiento" (*Attrition* y *Exhaustion*) o "Borrar" (*Erase* y *Expunge*).

Esos casos se quedan en el índice como lecturas alternativas y los resuelve el escáner: cuando la esquina da
set y número, se prueba contra todas las lecturas posibles y gana la que exista en esa edición. Sin esquina
legible se muestra la primera y se corrige con **Cambiar edición** o desde **Buscar**.

No hace falta regenerarlo con cada set nuevo: al arrancar, la app mira qué sets se publicaron después de la fecha
del archivo y baja sola sus nombres en esos idiomas (se guardan en IndexedDB). Para otros idiomas:
`node scripts/build-names.mjs fr de it` y activar el idioma en `nameLangs` (Ajustes solo expone es/pt).

## Depuración del reconocimiento

- Ajustes → **Mostrar texto del OCR** enseña lo que leyó la cámara en el nombre y en la esquina, y el tamaño de
  la carta detectada.
- En la consola del navegador, `window.__mtgDebug = true` muestra en pantalla los recortes que recibe el OCR.
- Ganchos de consola (en la pestaña Escanear):
  - `mtgScan.image('https://…/carta.jpg')`: pasa una imagen por el mismo flujo que la cámara.
  - `mtgScan.compose(url, { scale: 0.7, rotate: 3, bg: '#222' })`: pone la carta sobre un fondo, a ese tamaño
    y giro, y la escanea (para probar la detección sin cámara).
  - `mtgScan.inspect(url, { scale, ocr: true })`: solo la geometría (detección, inclinación, franjas, recortes
    como data URLs y, con `ocr`, lo que lee cada variante del título).
- Detección y franjas: `src/lib/detect.ts`. Preprocesado: `src/lib/image.ts`. Parser de la esquina:
  `src/lib/collector.ts`. Índice de nombres y umbrales del emparejamiento: `src/lib/names.ts`. Fuentes del índice
  (catálogo, archivos estáticos, sets nuevos): `src/lib/nameSources.ts`.

## Estructura

```
src/lib/        detect.ts (detección de la carta y franjas), image.ts (recortes y preprocesado),
                ocr.ts (Tesseract), names.ts (índice difuso multilingüe), nameSources.ts (de dónde salen
                los nombres), collector.ts (esquina), scryfall.ts (API + caché en IndexedDB vía db.ts),
                supabaseClient.ts (cliente Supabase), inventoryStore.ts (estado reactivo del inventario +
                tiempo real), inventory.ts (altas/bajas contra Supabase), migrateLocalInventory.ts (sube el
                IndexedDB viejo una sola vez), export.ts, camera.ts (cámara, zoom, linterna), settings.ts,
                addCard.ts
src/components/ Scanner, Inventory, Search, Settings, PrintingPicker, AddControls, Sheet, Toast, TabBar
scripts/        copy-tesseract.mjs (motor + idioma a public/tesseract), build-names.mjs (nombres es/pt),
                make_icons.py
public/names/   es.json, pt.json (generados)
```

## Limitaciones conocidas

- Cartas anteriores a 2003: la edición casi siempre hay que elegirla a mano (no traen set en la esquina; el
  "69/350" del borde a veces se lee y entonces sí se confirma).
- Cartas con el nombre sobre el arte (showcase, borderless) o nombres tapados: dependen de la esquina.
- El texto de la esquina es diminuto: con la carta pequeña en la imagen o poca luz se lee mal (prueba 4K o
  acércala); si el número no cuadra, la carta queda "sin confirmar" en vez de guardarse con la edición equivocada.
- Los precios son los de Scryfall en el momento de agregar (se refrescan al volver a agregar la misma carta).
- Si falla la consulta a Scryfall, el panel se vacía en vez de dejar la carta anterior en pantalla: así el
  botón **Agregar** nunca suma al inventario la carta del escaneo pasado.
- El inventario vive en Supabase (ver sección **Base de datos**), así que **escanear necesita internet**: sin
  red ni Scryfall ni el guardado funcionan. Al abrir la app con red, el inventario se ve igual en todos los
  dispositivos (y se actualiza solo, en vivo, si lo cambias desde otro).

Esta app no está afiliada a Scryfall ni a Wizards of the Coast. Magic: The Gathering es marca de Wizards of the Coast.
