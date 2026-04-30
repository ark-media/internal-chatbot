'use client';

import { usePathname } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { useIsChatDeleting } from '@/lib/chat-refresh';
import { activeChatId, detectSurface } from '@/lib/sidebar';

export function DeletionGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const surface = detectSurface(pathname);
  const chatId = activeChatId(pathname, surface);
  const isDeleting = useIsChatDeleting(chatId);

  if (isDeleting) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center text-white/40">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  return <>{children}</>;
}
