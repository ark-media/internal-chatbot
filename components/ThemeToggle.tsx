'use client';

import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { IconButton } from '@/components/ui/IconButton';

type Theme = 'light' | 'dark';

// Pre-bootstrap (no class on <html> yet) we don't know the theme. The
// bootstrap script in /theme-init.js adds the class before paint, so this
// only matters in the brief SSR / pre-hydration moment.
function getSnapshot(): Theme | null {
  if (typeof document === 'undefined') return null;
  const root = document.documentElement;
  if (root.classList.contains('theme-light')) return 'light';
  if (root.classList.contains('theme-dark')) return 'dark';
  return null;
}

function getServerSnapshot(): Theme | null {
  return null;
}

function subscribe(notify: () => void): () => void {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
  return () => observer.disconnect();
}

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    const root = document.documentElement;
    root.classList.remove('theme-light', 'theme-dark');
    root.classList.add(`theme-${next}`);
    try {
      sessionStorage.setItem('ark-theme', next);
    } catch {
      // sessionStorage can be unavailable (private mode, blocked cookies);
      // the class on <html> is the source of truth either way.
    }
  }

  const isLight = theme === 'light';
  const label = isLight ? 'Switch to dark theme' : 'Switch to light theme';

  return (
    <IconButton
      onClick={toggle}
      aria-label={label}
      title={label}
      className={className}
    >
      {theme === null ? (
        <span className="h-4 w-4" aria-hidden />
      ) : isLight ? (
        <Moon className="h-4 w-4" aria-hidden />
      ) : (
        <Sun className="h-4 w-4" aria-hidden />
      )}
    </IconButton>
  );
}
