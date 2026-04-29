'use client';

import Link from 'next/link';
import { ArkLogo } from '@/components/ArkLogo';
import { cn } from '@/lib/cn';

const SKY = '#3eb5f9';
const INK_900 = '#0b153c';

type HeaderVariant = 'archive' | 'prep' | 'news';

type HeaderProps = {
  variant: HeaderVariant;
  episodeCount?: number | null;
};

const variantLabels: Record<HeaderVariant, string> = {
  archive: 'Transcript Assistant',
  prep: 'Prep',
  news: 'News Daily',
};

export function Header({ variant, episodeCount }: HeaderProps) {
  return (
    <header className="relative z-10 flex items-center justify-between gap-4 border-b border-white/[0.06] bg-white/[0.02] px-6 py-3 backdrop-blur-md">
      <div className="flex items-center gap-3">
        <ArkLogo
          className="h-9 text-white"
          bg={SKY}
          fg={INK_900}
          markOnly
        />
        <div className="leading-tight">
          <div
            className="text-[0.95rem] font-black tracking-tight text-white"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Ark Media
          </div>
          <div className="text-[0.72rem] uppercase tracking-[0.22em] text-white/45">
            {variantLabels[variant]}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <nav className="flex items-center gap-1 text-[0.75rem]">
          <Link
            href="/"
            className={cn(
              'rounded-md px-2.5 py-1 transition',
              variant === 'archive'
                ? 'rounded-md bg-[#3eb5f9]/[0.12] text-[#79cdfc]'
                : 'text-white/60 hover:bg-white/[0.05] hover:text-white',
            )}
          >
            Archive
          </Link>
          <Link
            href="/prep"
            className={cn(
              'rounded-md px-2.5 py-1 transition',
              variant === 'prep'
                ? 'bg-[#3eb5f9]/[0.12] text-[#79cdfc]'
                : 'text-white/60 hover:bg-white/[0.05] hover:text-white',
            )}
          >
            Prep
          </Link>
          <Link
            href="/news"
            className={cn(
              'rounded-md px-2.5 py-1 transition',
              variant === 'news'
                ? 'bg-[#3eb5f9]/[0.12] text-[#79cdfc]'
                : 'text-white/60 hover:bg-white/[0.05] hover:text-white',
            )}
          >
            News
          </Link>
        </nav>

        {episodeCount !== undefined && (
          <div className="hidden items-center gap-2 text-[0.7rem] text-white/40 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]" />
            <span>{episodeCount ?? '—'} episodes indexed</span>
          </div>
        )}
      </div>
    </header>
  );
}
