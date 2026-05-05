export type Surface = 'archive' | 'prep' | 'news' | 'scripts';

export const SURFACES: ReadonlyArray<{
  key: Surface;
  label: string;
  href: string;
  chatHrefBase: string;
}> = [
  { key: 'archive', label: 'Archive', href: '/', chatHrefBase: '/chat' },
  { key: 'prep', label: 'Prep', href: '/prep', chatHrefBase: '/prep' },
  { key: 'news', label: 'News', href: '/news', chatHrefBase: '/news' },
  {
    key: 'scripts',
    label: 'Scripts',
    href: '/news/orchestrator',
    chatHrefBase: '/news/orchestrator',
  },
];

export function detectSurface(pathname: string | null): Surface {
  if (!pathname) return 'archive';
  // Scripts must come before /news since its path is a prefix of /news.
  if (pathname.startsWith('/news/orchestrator')) return 'scripts';
  if (pathname.startsWith('/prep')) return 'prep';
  if (pathname.startsWith('/news')) return 'news';
  return 'archive';
}

// Sidebar list/delete go to different APIs depending on surface. Orchestrator
// runs live in their own table, not the chats table.
export function listEndpoint(surface: Surface): string {
  if (surface === 'scripts') return '/api/news/orchestrator';
  return `/api/chats?surface=${surface}`;
}

export function deleteEndpoint(surface: Surface, chatId: string): string {
  if (surface === 'scripts') return `/api/news/orchestrator/${chatId}`;
  return `/api/chats/${chatId}?confirm=1`;
}

export function activeChatId(
  pathname: string | null,
  surface: Surface,
): string | null {
  if (!pathname) return null;
  const base = SURFACES.find((s) => s.key === surface)?.chatHrefBase;
  if (!base) return null;
  if (!pathname.startsWith(`${base}/`)) return null;
  return pathname.slice(base.length + 1).split('/')[0] || null;
}

export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}
