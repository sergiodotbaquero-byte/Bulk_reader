import { useCallback, useEffect, useRef, useState } from 'react';
import { Inventory } from './components/Inventory';
import { Scanner } from './components/Scanner';
import { Search } from './components/Search';
import { Settings } from './components/Settings';
import { TabBar, type Tab } from './components/TabBar';
import { ToastProvider } from './components/Toast';
import { migrateLocalInventory } from './lib/migrateLocalInventory';
import { NameIndex } from './lib/names';
import { buildNameIndex, updateRecentSetNames } from './lib/nameSources';
import { fetchSets } from './lib/scryfall';
import { useSettings } from './lib/settings';

export default function App() {
  const [settings] = useSettings();
  const [tab, setTab] = useState<Tab>('scan');
  const [index, setIndex] = useState<NameIndex | null>(null);
  const [indexStatus, setIndexStatus] = useState('');
  const [indexError, setIndexError] = useState<string | null>(null);
  const [, setIndexVersion] = useState(0);
  const generation = useRef(0);

  const langsKey = settings.nameLangs.join(',');
  const loadIndex = useCallback(
    async (force = false) => {
      const gen = ++generation.current;
      const langs = langsKey ? langsKey.split(',') : [];
      setIndexError(null);
      try {
        const built = await buildNameIndex(langs, setIndexStatus, force);
        if (gen !== generation.current) return;
        setIndex(built.index);
        setIndexStatus('');
        if (built.missing.length) {
          setIndexError(`sin nombres en ${built.missing.map((l) => l.toUpperCase()).join(', ')} (falta public/names)`);
        }
        // Sets publicados después de generar los archivos de nombres: se completan en segundo plano.
        const delta = await updateRecentSetNames(built.index, langs, built.builtAt).catch(() => null);
        if (gen === generation.current && delta?.added) setIndexVersion((v) => v + 1);
      } catch (e) {
        if (gen !== generation.current) return;
        setIndexStatus('');
        setIndexError((e as Error).message || 'sin conexión');
      }
    },
    [langsKey],
  );

  useEffect(() => {
    void loadIndex();
    void fetchSets().catch(() => undefined);
    void migrateLocalInventory().catch(() => undefined);
  }, [loadIndex]);

  return (
    <ToastProvider>
      <div className="app">
        {tab === 'scan' && (
          <Scanner
            index={index}
            indexStatus={indexStatus}
            indexError={indexError}
            onRetryIndex={() => void loadIndex()}
            goSearch={() => setTab('search')}
          />
        )}
        {tab === 'inventory' && <Inventory />}
        {tab === 'search' && <Search index={index} />}
        {tab === 'settings' && <Settings index={index} onReloadNames={() => loadIndex(true)} />}
        <TabBar tab={tab} onChange={setTab} />
      </div>
    </ToastProvider>
  );
}
