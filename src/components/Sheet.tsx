import { useEffect, type ReactNode } from 'react';

export function Sheet({
  title,
  onClose,
  children,
  right,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  right?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <button type="button" className="sheet-backdrop" aria-label="Cerrar" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <div className="hstack">
            {right}
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </>
  );
}
