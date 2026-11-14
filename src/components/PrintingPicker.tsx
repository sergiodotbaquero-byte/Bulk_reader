import { useMemo, useState } from 'react';
import type { ScryfallCard } from '../types';
import { money, rarityShort, year } from '../lib/format';
import { cardImage, unitPrice } from '../lib/scryfall';
import { useSettings } from '../lib/settings';
import { Sheet } from './Sheet';

export function PrintingList({
  printings,
  selectedId,
  onSelect,
  filter = '',
}: {
  printings: ScryfallCard[];
  selectedId: string | null;
  onSelect: (card: ScryfallCard) => void;
  filter?: string;
}) {
  const [settings] = useSettings();
  const f = filter.trim().toLowerCase();
  const list = useMemo(
    () =>
      printings.filter(
        (p) =>
          !f ||
          p.set_name.toLowerCase().includes(f) ||
          p.set.includes(f) ||
          p.collector_number.toLowerCase().includes(f) ||
          year(p.released_at).includes(f),
      ),
    [printings, f],
  );
  if (!list.length) return <div className="empty">Sin impresiones que coincidan.</div>;
  return (
    <div className="prints">
      {list.map((p) => {
        const img = cardImage(p, 'small');
        const foil = (p.finishes ?? []).includes('foil');
        return (
          <button
            key={p.id}
            type="button"
            className={`print ${p.id === selectedId ? 'sel' : ''}`}
            onClick={() => onSelect(p)}
          >
            {img ? <img className="thumb" src={img} alt="" loading="lazy" /> : <div className="thumb" />}
            <div className="grow">
              <div className="row-title">{p.set_name}</div>
              <div className="row-sub">
                <span>
                  {p.set.toUpperCase()} · #{p.collector_number} · {year(p.released_at)}
                </span>
                <span className={`r-${p.rarity}`}>{rarityShort(p.rarity)}</span>
                {p.promo && <span className="badge">promo</span>}
                {p.lang !== 'en' && <span className="badge lang">{p.lang.toUpperCase()}</span>}
              </div>
            </div>
            <div className="row-side small">
              <span className="price">{money(unitPrice(p, 'nonfoil', settings.currency), settings.currency)}</span>
              {foil && (
                <span className="muted">foil {money(unitPrice(p, 'foil', settings.currency), settings.currency)}</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function PrintingPicker({
  printings,
  selectedId,
  onSelect,
  onClose,
}: {
  printings: ScryfallCard[] | null;
  selectedId: string | null;
  onSelect: (card: ScryfallCard) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  return (
    <Sheet title="Elige la edición" onClose={onClose}>
      <input
        className="input"
        placeholder="Filtrar por set, número o año…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        enterKeyHint="search"
        style={{ marginBottom: 10 }}
      />
      {!printings ? (
        <div className="center" style={{ padding: 24 }}>
          <span className="spinner" />
        </div>
      ) : (
        <>
          <PrintingList printings={printings} selectedId={selectedId} onSelect={onSelect} filter={filter} />
          <div className="small muted center" style={{ marginTop: 10 }}>
            {printings.length} impresiones (sin versiones digitales)
          </div>
        </>
      )}
    </Sheet>
  );
}
