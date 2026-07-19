'use client';

import { useEffect, useState } from 'react';

interface ToastMsg {
  id: number;
  text: string;
  kind: 'ok' | 'error';
  undo?: () => void;
}

export function toast(text: string, opts: { kind?: 'ok' | 'error'; undo?: () => void } = {}) {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: { text, kind: opts.kind || 'ok', undo: opts.undo } }));
}

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);

  useEffect(() => {
    let n = 0;
    const handler = (e: Event) => {
      const { text, kind, undo } = (e as CustomEvent).detail;
      const id = ++n;
      setToasts(t => [...t, { id, text, kind, undo }]);
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
    };
    window.addEventListener('app-toast', handler);
    return () => window.removeEventListener('app-toast', handler);
  }, []);

  if (!toasts.length) return null;
  return (
    <div className="toast-wrap">
      {toasts.map(t => (
        <div key={t.id} className={`toast${t.kind === 'error' ? ' error' : ''}`}>
          <span>{t.kind === 'error' ? '⚠' : '✓'}</span>
          <span style={{ flex: 1 }}>{t.text}</span>
          {t.undo && (
            <span
              style={{ color: 'var(--muted)', cursor: 'pointer' }}
              onClick={() => {
                t.undo!();
                setToasts(list => list.filter(x => x.id !== t.id));
              }}
            >
              Ongedaan maken
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
