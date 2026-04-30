'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Plus, Trash2, MessageSquare } from 'lucide-react';

import { ArkLogo } from '@/components/ArkLogo';
import { cn } from '@/lib/cn';
import { useChatUpdates } from '@/lib/chat-refresh';
import {
  SURFACES,
  activeChatId,
  detectSurface,
  formatRelative,
  type Surface,
} from '@/lib/sidebar';

type ChatSummary = {
  id: string;
  title: string | null;
  updated_at: string;
};

const PENDING_DELETE_TIMEOUT_MS = 3000;

export function ChatSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const currentSurface = detectSurface(pathname);

  const [viewSurface, setViewSurface] = useState<Surface>(currentSurface);
  // "Adjusting state when a prop/derived value changes" — runs during render so
  // viewSurface follows URL navigation without an extra paint from useEffect.
  const [lastSyncedSurface, setLastSyncedSurface] = useState<Surface>(currentSurface);
  if (lastSyncedSurface !== currentSurface) {
    setLastSyncedSurface(currentSurface);
    setViewSurface(currentSurface);
  }

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const refresh = useCallback(async (surface: Surface) => {
    try {
      const res = await fetch(`/api/chats?surface=${surface}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { chats?: ChatSummary[] };
      setChats(data.chats ?? []);
    } catch {
      // ignore — sidebar is best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    refresh(viewSurface);
  }, [viewSurface, refresh]);

  const onUpdated = useCallback(() => {
    refresh(viewSurface);
  }, [refresh, viewSurface]);
  useChatUpdates(onUpdated);

  useEffect(() => {
    if (!pendingDelete) return;
    const t = window.setTimeout(
      () => setPendingDelete(null),
      PENDING_DELETE_TIMEOUT_MS,
    );
    return () => window.clearTimeout(t);
  }, [pendingDelete]);

  const newChatHref = useMemo(
    () => SURFACES.find((s) => s.key === viewSurface)?.href ?? '/',
    [viewSurface],
  );

  const onDelete = useCallback(
    async (chatId: string) => {
      const wasActive = pathname?.includes(`/${chatId}`);
      try {
        await fetch(`/api/chats/${chatId}?confirm=1`, { method: 'DELETE' });
      } catch {
        return;
      }
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (wasActive) {
        const home = SURFACES.find((s) => s.key === viewSurface)?.href ?? '/';
        router.push(home);
      }
    },
    [pathname, router, viewSurface],
  );

  const handleDeleteClick = useCallback(
    (e: React.MouseEvent, chatId: string) => {
      e.preventDefault();
      e.stopPropagation();
      if (pendingDelete === chatId) {
        setPendingDelete(null);
        onDelete(chatId);
      } else {
        setPendingDelete(chatId);
      }
    },
    [onDelete, pendingDelete],
  );

  const activeId = activeChatId(pathname, viewSurface);

  return (
    <aside
      className={cn(
        'flex h-screen w-[260px] shrink-0 flex-col border-r border-white/[0.06]',
        'bg-white/[0.02] backdrop-blur-md',
      )}
      style={{ fontFamily: 'var(--font-sans)' }}
    >
      <div className="flex items-center gap-2 px-4 pt-5 pb-3">
        <ArkLogo className="h-7 text-white" bg="#3eb5f9" fg="#0b153c" markOnly />
        <span
          className="text-[0.85rem] font-black tracking-tight text-white"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Ark Media
        </span>
      </div>

      <div className="px-3 pb-3">
        <Link
          href={newChatHref}
          className={cn(
            'flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2',
            'text-[0.82rem] text-white/85 transition hover:bg-white/[0.08]',
          )}
        >
          <Plus className="h-3.5 w-3.5 text-[#3eb5f9]" />
          New chat
        </Link>
      </div>

      <div className="flex gap-1 px-3 pb-3 text-[0.72rem]">
        {SURFACES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setViewSurface(s.key)}
            className={cn(
              'rounded-md px-2 py-1 transition',
              viewSurface === s.key
                ? 'bg-[#3eb5f9]/[0.14] text-[#79cdfc]'
                : 'text-white/55 hover:bg-white/[0.05] hover:text-white',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {loading && chats.length === 0 ? (
          <div className="px-2 py-4 text-[0.72rem] text-white/30">Loading…</div>
        ) : chats.length === 0 ? (
          <div className="px-2 py-4 text-[0.72rem] text-white/30">
            No saved chats. Send a message to start.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {chats.map((c) => {
              const base = SURFACES.find((s) => s.key === viewSurface)?.chatHrefBase ?? '/chat';
              const href = `${base}/${c.id}`;
              const isActive = c.id === activeId;
              const isPendingDelete = pendingDelete === c.id;
              return (
                <li key={c.id} className="group relative">
                  <Link
                    href={href}
                    className={cn(
                      'flex items-start gap-2 rounded-md px-2 py-2 pr-8 text-[0.8rem] leading-snug transition',
                      isActive
                        ? 'bg-white/[0.06] text-white'
                        : 'text-white/70 hover:bg-white/[0.04] hover:text-white',
                    )}
                  >
                    <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/35" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{c.title?.trim() || 'Untitled chat'}</div>
                      <div className="mt-0.5 text-[0.66rem] text-white/35">
                        {formatRelative(c.updated_at)}
                      </div>
                    </div>
                  </Link>
                  <button
                    type="button"
                    aria-label={
                      isPendingDelete
                        ? `Confirm delete chat ${c.title ?? c.id}`
                        : `Delete chat ${c.title ?? c.id}`
                    }
                    title={isPendingDelete ? 'Click again to confirm' : 'Delete'}
                    onClick={(e) => handleDeleteClick(e, c.id)}
                    className={cn(
                      'absolute right-1.5 top-1.5 rounded p-1 transition',
                      isPendingDelete
                        ? 'bg-red-500/25 text-red-200 opacity-100'
                        : 'text-white/40 opacity-0 group-hover:opacity-100 hover:bg-red-500/15 hover:text-red-300',
                    )}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-white/[0.06] px-4 py-3 text-[0.65rem] uppercase tracking-[0.18em] text-white/30">
        Chats expire after 7 days
      </div>
    </aside>
  );
}
