import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { FINISH_LABEL, type InventoryItem } from '../types';
import { db } from '../lib/db';
import { importJsonBackup, saveOrShare, stamp, toJsonBackup, toManaBoxCsv, toSimpleCsv } from '../lib/export';
import { money, rarityShort, timeAgo } from '../lib/format';
import { changeQuantity, clearInventory, removeItem, totals, undoLastScan, updateItem } from '../lib/inventory';
import { useSettings } from '../lib/settings';
import { AddControls, Stepper, type AddState } from './AddControls';
import { Icon } from './Icons';
import { Sheet } from './Sheet';
import { useToast } from './Toast';

type Sort = 'recent' | 'name' | 'price' | 'qty' | 'set';

function priceOf(i: InventoryItem, currency: 'usd' | 'eur'): number | null {
  return currency === 'usd' ? i.priceUsd : i.priceEur;
}

export function Inventory() {
  const [settings] = useSettings();
  const toast = useToast();
  const items = useLiveQuery(() => db.inventory.toArray(), []);
  const [q, setQ] = useState('');
  const [setFilter, setSetFilter] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [limit, setLimit] = useState(150);
  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [dataOpen, setDataOpen] = useState(false);

  const sets = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items ?? []) m.set(i.setCode, i.setName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);

  const filtered = useMemo(() => {
    const list = (items ?? []).filter((i) => {
      if (setFilter && i.setCode !== setFilter) return false;
      if (q) {
        const t = q.toLowerCase();
        return (
          i.name.toLowerCase().includes(t) ||
          (i.printedName ?? '').toLowerCase().includes(t) ||
          i.setName.toLowerCase().includes(t) ||
          i.setCode.includes(t) ||
          i.collectorNumber.toLowerCase() === t
        );
      }
      return true;
    });
    const cur = settings.currency;
    list.sort((a, b) => {
      switch (sort) {
        case 'name':
          return a.name.localeCompare(b.name) || a.setCode.localeCompare(b.setCode);
        case 'price':
          return (priceOf(b, cur) ?? -1) * b.quantity - (priceOf(a, cur) ?? -1) * a.quantity;
        case 'qty':
          return b.quantity - a.quantity || a.name.localeCompare(b.name);
        case 'set':
          return (
            a.setName.localeCompare(b.setName) ||
            parseInt(a.collectorNumber, 10) - parseInt(b.collectorNumber, 10) ||
            a.collectorNumber.localeCompare(b.collectorNumber)
          );
        default:
          return b.updatedAt - a.updatedAt;
      }
    });
    return list;
  }, [items, q, setFilter, sort, settings.currency]);

  const t = useMemo(() => totals(filtered), [filtered]);
  const all = useMemo(() => totals(items ?? []), [items]);
  const value = settings.currency === 'usd' ? t.valueUsd : t.valueEur;

  const exportAs = async (kind: 'manabox' | 'csv' | 'json') => {
    const list = items ?? [];
    if (!list.length) {
      toast.show('El inventario está vacío.');
      return;
    }
    try {
      const s = stamp();
      const r =
        kind === 'manabox'
          ? await saveOrShare(`inventario-manabox-${s}.csv`, toManaBoxCsv(list), 'text/csv')
          : kind === 'csv'
            ? await saveOrShare(`inventario-${s}.csv`, toSimpleCsv(list), 'text/csv')
            : await saveOrShare(`respaldo-mtg-${s}.json`, toJsonBackup(list), 'application/json');
      toast.show(r === 'shared' ? 'Archivo compartido.' : 'Archivo descargado.', { kind: 'ok' });
    } catch (e) {
      toast.show(`No se pudo exportar: ${(e as Error).message}`, { kind: 'err' });
    }
  };

  const importFile = async (file: File) => {
    try {
      const r = await importJsonBackup(await file.text());
      toast.show(`Importado: ${r.added} filas nuevas, ${r.merged} sumadas.`, { kind: 'ok' });
      setDataOpen(false);
    } catch (e) {
      toast.show(`No se pudo importar: ${(e as Error).message}`, { kind: 'err' });
    }
  };

  const undo = async () => {
    const d = await undoLastScan();
    toast.show(d ? `Deshecho: ${d}` : 'No hay nada que deshacer.');
  };

  const wipe = async () => {
    const n = all.cards;
    if (!window.confirm(`¿Borrar TODO el inventario (${n} cartas)? Esto no se puede deshacer.`)) return;
    if (!window.confirm('Última confirmación: ¿seguro que quieres vaciar el inventario?')) return;
    await clearInventory();
    setDataOpen(false);
    toast.show('Inventario vaciado.');
  };

  return (
    <div className="view">
      <div className="sticky-top">
        <div className="spread" style={{ marginBottom: 10 }}>
          <div>
            <h1 className="h1">Inventario</h1>
            <p className="sub" style={{ margin: 0 }}>
              {all.cards} cartas · {all.rows} filas
            </p>
          </div>
          <div className="hstack">
            <button type="button" className="btn btn-icon" title="Deshacer último movimiento" onClick={() => void undo()}>
              <Icon name="undo" />
            </button>
            <button type="button" className="btn btn-icon" title="Exportar / importar" onClick={() => setDataOpen(true)}>
              <Icon name="download" />
            </button>
          </div>
        </div>
        <input
          className="input"
          placeholder="Buscar por nombre, set o número…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
        />
        <div className="hstack" style={{ marginTop: 8 }}>
          <select className="input" value={setFilter} onChange={(e) => setSetFilter(e.target.value)} aria-label="Set">
            <option value="">Todos los sets</option>
            {sets.map(([code, name]) => (
              <option key={code} value={code}>
                {name} ({code.toUpperCase()})
              </option>
            ))}
          </select>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Orden">
            <option value="recent">Recientes</option>
            <option value="name">Nombre</option>
            <option value="price">Valor</option>
            <option value="qty">Cantidad</option>
            <option value="set">Set y número</option>
          </select>
        </div>
      </div>

      <div className="totals">
        <div className="card">
          <div className="n">{t.cards}</div>
          <div className="l">cartas</div>
        </div>
        <div className="card">
          <div className="n">{t.rows}</div>
          <div className="l">distintas</div>
        </div>
        <div className="card">
          <div className="n">{money(value, settings.currency)}</div>
          <div className="l">valor{t.priced < t.cards ? ` (${t.cards - t.priced} sin precio)` : ''}</div>
        </div>
      </div>

      {items === undefined ? (
        <div className="center" style={{ padding: 30 }}>
          <span className="spinner" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          {items.length === 0 ? 'Aún no hay cartas. Escanea la primera en la pestaña Escanear.' : 'Nada coincide con el filtro.'}
        </div>
      ) : (
        <div className="card" style={{ padding: 4 }}>
          {filtered.slice(0, limit).map((i) => (
            <div className="row" key={i.id}>
              <button type="button" className="row-main" style={{ gridColumn: '1 / 3' }} onClick={() => setEditing(i)}>
                {i.imageSmall ? <img className="thumb" src={i.imageSmall} alt="" loading="lazy" /> : <div className="thumb" />}
                <div className="grow">
                  <div className="row-title">{i.printedName && i.lang !== 'en' ? `${i.printedName} · ${i.name}` : i.name}</div>
                  <div className="row-sub">
                    <span>
                      {i.setCode.toUpperCase()} #{i.collectorNumber}
                    </span>
                    <span className={`r-${i.rarity}`}>{rarityShort(i.rarity)}</span>
                    {i.finish !== 'nonfoil' && <span className={`badge ${i.finish}`}>{FINISH_LABEL[i.finish]}</span>}
                    <span className="badge">{i.condition}</span>
                    {i.lang !== 'en' && <span className="badge lang">{i.lang.toUpperCase()}</span>}
                  </div>
                </div>
              </button>
              <div className="row-side">
                <span className="price">{money(priceOf(i, settings.currency), settings.currency)}</span>
                <div className="stepper sm">
                  <button type="button" aria-label="Quitar una" onClick={() => void changeQuantity(i.id!, -1)}>
                    −
                  </button>
                  <span>{i.quantity}</span>
                  <button type="button" aria-label="Agregar una" onClick={() => void changeQuantity(i.id!, 1)}>
                    +
                  </button>
                </div>
              </div>
            </div>
          ))}
          {filtered.length > limit && (
            <button type="button" className="btn btn-block btn-ghost" onClick={() => setLimit((l) => l + 150)}>
              Mostrar más ({filtered.length - limit} restantes)
            </button>
          )}
        </div>
      )}

      {editing && (
        <ItemSheet
          item={editing}
          onClose={() => setEditing(null)}
          onDeleted={() => {
            setEditing(null);
            toast.show('Fila eliminada.');
          }}
        />
      )}

      {dataOpen && (
        <Sheet title="Exportar e importar" onClose={() => setDataOpen(false)}>
          <div className="stack">
            <button type="button" className="btn btn-primary" onClick={() => void exportAs('manabox')}>
              <Icon name="download" /> CSV para ManaBox
            </button>
            <button type="button" className="btn" onClick={() => void exportAs('csv')}>
              <Icon name="download" /> CSV para Excel / Sheets
            </button>
            <button type="button" className="btn" onClick={() => void exportAs('json')}>
              <Icon name="download" /> Respaldo completo (JSON)
            </button>
            <label className="btn file-btn">
              <Icon name="upload" /> Importar respaldo JSON
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                  e.target.value = '';
                }}
              />
            </label>
            <p className="small muted" style={{ margin: '4px 0' }}>
              El inventario vive en este dispositivo (IndexedDB). Exporta un respaldo JSON de vez en cuando; se puede
              importar en otro celular y las cantidades se suman.
            </p>
            <button type="button" className="btn btn-danger" onClick={() => void wipe()}>
              <Icon name="trash" /> Vaciar inventario
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function ItemSheet({ item, onClose, onDeleted }: { item: InventoryItem; onClose: () => void; onDeleted: () => void }) {
  const [settings] = useSettings();
  const [state, setState] = useState<AddState>({
    finish: item.finish,
    condition: item.condition,
    lang: item.lang,
    quantity: item.quantity,
  });
  const [notes, setNotes] = useState(item.notes);
  const dirty =
    state.finish !== item.finish ||
    state.condition !== item.condition ||
    state.lang !== item.lang ||
    state.quantity !== item.quantity ||
    notes !== item.notes;

  const save = async () => {
    await updateItem(item.id!, { ...state, notes });
    onClose();
  };

  const price = priceOf(item, settings.currency);
  return (
    <Sheet
      title={item.name}
      onClose={onClose}
      right={
        <button type="button" className="btn btn-sm btn-primary" disabled={!dirty} onClick={() => void save()}>
          Guardar
        </button>
      }
    >
      {item.imageNormal && <img className="hero-img" src={item.imageNormal} alt="" />}
      <div className="center small muted" style={{ marginBottom: 12 }}>
        {item.setName} ({item.setCode.toUpperCase()}) · #{item.collectorNumber} · {rarityShort(item.rarity)}
        <br />
        {money(price, settings.currency)} c/u · agregada {timeAgo(item.addedAt)} ·{' '}
        <a className="link" href={item.scryfallUri} target="_blank" rel="noreferrer">
          Scryfall
        </a>
      </div>
      <div className="field">
        <span className="label">Cantidad</span>
        <Stepper value={state.quantity} onChange={(q) => setState({ ...state, quantity: q })} min={0} />
      </div>
      <div className="field">
        <span className="label">Acabado · idioma · estado</span>
        <AddControls state={state} onChange={setState} finishes={['nonfoil', 'foil', 'etched']} />
      </div>
      <div className="field">
        <span className="label">Notas</span>
        <textarea
          className="input"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Caja, lote, firma, detalles…"
        />
      </div>
      <button
        type="button"
        className="btn btn-danger btn-block"
        onClick={() => {
          if (window.confirm(`¿Eliminar ${item.name} (${item.quantity}) del inventario?`)) {
            void removeItem(item.id!).then(onDeleted);
          }
        }}
      >
        <Icon name="trash" /> Eliminar fila
      </button>
    </Sheet>
  );
}
