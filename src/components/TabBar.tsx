import { Icon, type IconName } from './Icons';

export type Tab = 'scan' | 'inventory' | 'search' | 'settings';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'scan', label: 'Escanear', icon: 'scan' },
  { id: 'inventory', label: 'Inventario', icon: 'list' },
  { id: 'search', label: 'Buscar', icon: 'search' },
  { id: 'settings', label: 'Ajustes', icon: 'settings' },
];

export function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="tabbar" aria-label="Secciones">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tab ${tab === t.id ? 'active' : ''}`}
          aria-current={tab === t.id ? 'page' : undefined}
          onClick={() => onChange(t.id)}
        >
          <Icon name={t.icon} size={24} />
          {t.label}
        </button>
      ))}
    </nav>
  );
}
