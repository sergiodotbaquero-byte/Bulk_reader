import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export interface ToastOptions {
  kind?: 'ok' | 'err' | 'info';
  action?: { label: string; onClick: () => void };
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}

interface ToastApi {
  show: (message: string, opts?: ToastOptions) => void;
}

const Ctx = createContext<ToastApi>({ show: () => undefined });

export function useToast(): ToastApi {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const show = useCallback((message: string, opts: ToastOptions = {}) => {
    const id = ++seq.current;
    setItems((l) => [...l.slice(-2), { id, message, ...opts }]);
    const ms = opts.duration ?? (opts.action ? 5000 : 2600);
    window.setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), ms);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind ?? ''}`}>
            <span className="grow">{t.message}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick();
                  setItems((l) => l.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
