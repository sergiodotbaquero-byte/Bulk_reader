import { useEffect, useState } from 'react';
import type { ScryfallCard } from '../types';
import { addCard } from '../lib/addCard';
import { feedbackAdded, feedbackError } from '../lib/feedback';
import { money, rarityShort, year } from '../lib/format';
import type { NameIndex, NameOption } from '../lib/names';
import {
  autocompleteNames,
  availableFinishes,
  cardImage,
  displayName,
  getCardByExactName,
  getCardBySetNumber,
  getPrintings,
  unitPrice,
} from '../lib/scryfall';
import { useSettings } from '../lib/settings';
import { AddControls, Stepper, type AddState } from './AddControls';
import { Icon } from './Icons';
import { PrintingList } from './PrintingPicker';
import { useToast } from './Toast';

export function Search({ index }: { index: NameIndex | null }) {
  const [settings] = useSettings();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [sugs, setSugs] = useState<NameOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<ScryfallCard | null>(null);
  const [prints, setPrints] = useState<ScryfallCard[] | null>(null);
  const [filter, setFilter] = useState('');
  const [setCode, setSetCode] = useState('');
  const [num, setNum] = useState('');
  const [adding, setAdding] = useState(false);
  const [add, setAdd] = useState<AddState>({
    finish: settings.defaultFinish,
    condition: settings.defaultCondition,
    lang: settings.defaultLang,
    quantity: 1,
  });

  useEffect(() => {
    if (q.trim().length < 2 || (sel && q === sel.name)) {
      setSugs([]);
      return;
    }
    if (index) {
      // Índice local: inglés + español + portugués, funciona sin red.
      setSugs(index.suggest(q, 8, settings.defaultLang));
      return;
    }
    const t = window.setTimeout(() => {
      autocompleteNames(q)
        .then((names) => setSugs(names.map((n) => ({ name: n, printed: n, lang: 'en' }))))
        .catch(() => setSugs([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, sel, index, settings.defaultLang]);

  const choose = (card: ScryfallCard) => {
    setSel(card);
    const finishes = availableFinishes(card);
    setAdd((a) => ({ ...a, finish: finishes.includes(a.finish) ? a.finish : finishes[0], quantity: 1 }));
  };

  const pickName = async (o: NameOption) => {
    setSugs([]);
    setQ(o.name);
    setLoading(true);
    setPrints(null);
    try {
      const c = await getCardByExactName(o.name);
      choose(c);
      if (o.lang !== 'en') setAdd((a) => ({ ...a, lang: o.lang }));
      setPrints(await getPrintings(c));
    } catch (e) {
      toast.show(`No encontré «${o.printed}»: ${(e as Error).message}`, { kind: 'err' });
    } finally {
      setLoading(false);
    }
  };

  const lookupSetNumber = async () => {
    if (!setCode.trim() || !num.trim()) return;
    setLoading(true);
    setPrints(null);
    try {
      const c = await getCardBySetNumber(setCode.trim(), num.trim());
      setQ(c.name);
      choose(c);
      setPrints(await getPrintings(c));
    } catch {
      toast.show(`No existe ${setCode.toUpperCase()} #${num} en Scryfall.`, { kind: 'err' });
    } finally {
      setLoading(false);
    }
  };

  const doAdd = async () => {
    if (!sel) return;
    setAdding(true);
    try {
      const { item } = await addCard(sel, add);
      feedbackAdded();
      toast.show(
        `+${add.quantity} ${item.printedName ?? item.name} · ${item.setCode.toUpperCase()} #${item.collectorNumber} (total ×${item.quantity})`,
        { kind: 'ok' },
      );
      setAdd((a) => ({ ...a, quantity: 1 }));
    } catch (e) {
      feedbackError();
      toast.show(`No se pudo guardar: ${(e as Error).message}`, { kind: 'err' });
    } finally {
      setAdding(false);
    }
  };

  const img = sel ? cardImage(sel, 'normal') : null;

  return (
    <div className="view">
      <h1 className="h1">Buscar</h1>
      <p className="sub">Para cartas que la cámara no reconoce (muy viejas, dañadas, tapadas).</p>

      <input
        className="input"
        placeholder={index ? 'Nombre en inglés, español o portugués…' : 'Nombre de la carta (en inglés)…'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && q.trim()) void pickName(sugs[0] ?? { name: q.trim(), printed: q.trim(), lang: 'en' });
        }}
        enterKeyHint="search"
        autoCapitalize="none"
        autoCorrect="off"
      />
      {sugs.length > 0 && (
        <div className="autocomplete">
          {sugs.map((o) => (
            <button key={`${o.lang}|${o.printed}|${o.name}`} type="button" onClick={() => void pickName(o)}>
              {o.printed}
              {o.lang !== 'en' && (
                <span className="muted small">
                  {' '}
                  · {o.name} · {o.lang.toUpperCase()}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="hstack" style={{ marginTop: 10 }}>
        <input
          className="input"
          placeholder="Set (ej. MOM)"
          value={setCode}
          onChange={(e) => setSetCode(e.target.value)}
          autoCapitalize="characters"
          autoCorrect="off"
          style={{ flex: 1 }}
        />
        <input
          className="input"
          placeholder="Número"
          value={num}
          onChange={(e) => setNum(e.target.value)}
          inputMode="numeric"
          enterKeyHint="go"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void lookupSetNumber();
          }}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn" onClick={() => void lookupSetNumber()} disabled={!setCode || !num}>
          Ir
        </button>
      </div>

      {loading && (
        <div className="center" style={{ padding: 20 }}>
          <span className="spinner" />
        </div>
      )}

      {sel && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="scan-result">
            {img ? <img className="thumb lg" src={img} alt="" /> : <div className="thumb lg" />}
            <div className="grow">
              <div className="name" style={{ fontWeight: 800 }}>
                {displayName(sel)}
              </div>
              <div className="row-sub">
                <span>
                  {sel.set_name} ({sel.set.toUpperCase()}) · #{sel.collector_number} · {year(sel.released_at)}
                </span>
                <span className={`r-${sel.rarity}`}>{rarityShort(sel.rarity)}</span>
                <span className="price">{money(unitPrice(sel, add.finish, settings.currency), settings.currency)}</span>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <AddControls state={add} onChange={setAdd} finishes={availableFinishes(sel)} />
          </div>
          <div className="scan-actions" style={{ marginTop: 10 }}>
            <Stepper value={add.quantity} onChange={(v) => setAdd({ ...add, quantity: v })} />
            <button type="button" className="btn btn-primary btn-lg" disabled={adding} onClick={() => void doAdd()}>
              {adding ? <span className="spinner" /> : <Icon name="plus" />} Agregar
              {add.quantity > 1 ? ` ×${add.quantity}` : ''}
            </button>
          </div>
        </div>
      )}

      {sel && prints && (
        <>
          <h2 className="h2">Ediciones ({prints.length})</h2>
          <input
            className="input"
            placeholder="Filtrar por set, número o año…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            style={{ marginBottom: 8 }}
          />
          <div className="card" style={{ padding: 4 }}>
            <PrintingList printings={prints} selectedId={sel.id} onSelect={choose} filter={filter} />
          </div>
        </>
      )}
    </div>
  );
}
