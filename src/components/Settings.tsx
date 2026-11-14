import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { CONDITIONS, CONDITION_LABEL, FINISH_LABEL, LANGS, type Condition, type Finish } from '../types';
import { db } from '../lib/db';
import type { NameIndex } from '../lib/names';
import { useOcrStatus } from '../lib/ocr';
import { DEFAULT_SETTINGS, useSettings } from '../lib/settings';
import { useToast } from './Toast';

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="grow">
        <div className="t">{title}</div>
        {desc && <div className="d">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

const NAME_LANGS: { code: string; label: string }[] = [
  { code: 'es', label: 'Nombres en español' },
  { code: 'pt', label: 'Nombres en portugués' },
];

export function Settings({ index, onReloadNames }: { index: NameIndex | null; onReloadNames: () => Promise<void> }) {
  const [s, update] = useSettings();
  const toast = useToast();
  const ocr = useOcrStatus();
  const [reloading, setReloading] = useState(false);
  const cachedCards = useLiveQuery(() => db.cardCache.count(), []);

  const toggleLang = (code: string, on: boolean) => {
    const next = s.nameLangs.filter((l) => l !== code);
    if (on) next.push(code);
    update({ nameLangs: next });
  };

  const reloadNames = async () => {
    setReloading(true);
    try {
      await onReloadNames();
      toast.show('Catálogo de nombres actualizado.', { kind: 'ok' });
    } catch (e) {
      toast.show(`No se pudo actualizar: ${(e as Error).message}`, { kind: 'err' });
    } finally {
      setReloading(false);
    }
  };

  const clearCache = async () => {
    await db.cardCache.clear();
    await db.printsCache.clear();
    toast.show('Caché de Scryfall borrada.');
  };

  const counts = index
    ? ['en', ...s.nameLangs].map((l) => `${l.toUpperCase()} ${index.countFor(l).toLocaleString('es')}`).join(' · ')
    : 'cargando…';

  return (
    <div className="view">
      <h1 className="h1">Ajustes</h1>
      <p className="sub">Valores por defecto al agregar y comportamiento del escáner.</p>

      <h2 className="h2">Escáner</h2>
      <div className="card">
        <Row title="Agregar automáticamente" desc="Al reconocer una carta se suma al inventario sin tocar nada (estilo ManaBox).">
          <Switch on={s.autoAdd} onChange={(v) => update({ autoAdd: v })} />
        </Row>
        <Row
          title="Auto-agregar aunque no se lea la edición"
          desc="Si no se puede leer el set de la carta, agrega la impresión más reciente igual. Riesgoso para el precio."
        >
          <Switch on={s.autoAddUnconfirmed} onChange={(v) => update({ autoAddUnconfirmed: v })} />
        </Row>
        <Row
          title="Leer número y set de la carta"
          desc="Lee la esquina inferior (ej. 123/274 · MOM • EN) para fijar la edición exacta; también identifica cartas sin nombre legible (lands a arte completo, otros idiomas)."
        >
          <Switch on={s.readCollectorCode} onChange={(v) => update({ readCollectorCode: v })} />
        </Row>
        {NAME_LANGS.map((l) => (
          <Row
            key={l.code}
            title={l.label}
            desc={`Reconocer cartas impresas en ${l.code === 'es' ? 'español' : 'portugués'} por su nombre (≈1 MB más de catálogo).`}
          >
            <Switch on={s.nameLangs.includes(l.code)} onChange={(v) => toggleLang(l.code, v)} />
          </Row>
        ))}
        <Row title="Sonido al agregar">
          <Switch on={s.sound} onChange={(v) => update({ sound: v })} />
        </Row>
        <Row title="Vibración al agregar">
          <Switch on={s.vibrate} onChange={(v) => update({ vibrate: v })} />
        </Row>
        <Row
          title="Tamaño del marco guía"
          desc="Solo es una guía: la carta se detecta sola a cualquier tamaño. El marco se usa si no se logra detectarla."
        >
          <input
            type="range"
            min={0.6}
            max={0.98}
            step={0.02}
            value={s.frameScale}
            onChange={(e) => update({ frameScale: parseFloat(e.target.value) })}
            style={{ width: 120 }}
          />
        </Row>
        <Row
          title="Resolución de la cámara"
          desc="4K da más detalle para leer el número de la esquina, pero exige más al celular. Si va lento, vuelve a 1080p."
        >
          <select
            className="input"
            style={{ width: 'auto' }}
            value={s.cameraRes}
            onChange={(e) => update({ cameraRes: e.target.value as '1080p' | '4k' })}
          >
            <option value="1080p">1080p</option>
            <option value="4k">4K</option>
          </select>
        </Row>
        <Row title="Mostrar texto del OCR" desc="Para depurar qué está leyendo la cámara.">
          <Switch on={s.showOcrDebug} onChange={(v) => update({ showOcrDebug: v })} />
        </Row>
      </div>

      <h2 className="h2">Por defecto al agregar</h2>
      <div className="card">
        <Row title="Estado">
          <select
            className="input"
            style={{ width: 'auto' }}
            value={s.defaultCondition}
            onChange={(e) => update({ defaultCondition: e.target.value as Condition })}
          >
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {c} · {CONDITION_LABEL[c]}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Acabado">
          <select
            className="input"
            style={{ width: 'auto' }}
            value={s.defaultFinish}
            onChange={(e) => update({ defaultFinish: e.target.value as Finish })}
          >
            {(['nonfoil', 'foil', 'etched'] as Finish[]).map((f) => (
              <option key={f} value={f}>
                {FINISH_LABEL[f]}
              </option>
            ))}
          </select>
        </Row>
        <Row
          title="Idioma de las cartas"
          desc="Se usa si no se puede saber por la carta. El idioma leído en la esquina o en el nombre lo sobreescribe."
        >
          <select
            className="input"
            style={{ width: 'auto' }}
            value={s.defaultLang}
            onChange={(e) => update({ defaultLang: e.target.value })}
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Moneda de referencia" desc="Precios de Scryfall (TCGplayer en USD, Cardmarket en EUR).">
          <select
            className="input"
            style={{ width: 'auto' }}
            value={s.currency}
            onChange={(e) => update({ currency: e.target.value as 'usd' | 'eur' })}
          >
            <option value="usd">USD</option>
            <option value="eur">EUR</option>
          </select>
        </Row>
      </div>

      <h2 className="h2">Datos</h2>
      <div className="card">
        <Row title="Catálogo de nombres" desc={`${counts} · motor OCR: ${ocr.message}`}>
          <button type="button" className="btn btn-sm" disabled={reloading} onClick={() => void reloadNames()}>
            {reloading ? <span className="spinner" /> : 'Actualizar'}
          </button>
        </Row>
        <Row title="Caché de cartas de Scryfall" desc={`${cachedCards ?? 0} cartas guardadas (precios de hasta 24 h).`}>
          <button type="button" className="btn btn-sm" onClick={() => void clearCache()}>
            Borrar
          </button>
        </Row>
        <Row title="Restablecer ajustes">
          <button type="button" className="btn btn-sm" onClick={() => update(DEFAULT_SETTINGS)}>
            Restablecer
          </button>
        </Row>
      </div>

      <p className="small muted" style={{ marginTop: 20 }}>
        MTG Bulk Scanner v{__APP_VERSION__}. Datos de cartas y precios por{' '}
        <a className="link" href="https://scryfall.com" target="_blank" rel="noreferrer">
          Scryfall
        </a>
        . Esta app no está afiliada ni respaldada por Scryfall ni por Wizards of the Coast. Magic: The Gathering es
        marca de Wizards of the Coast.
      </p>
    </div>
  );
}
