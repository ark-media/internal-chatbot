'use client';

import Link from 'next/link';
import { ArkLogo } from '@/components/ArkLogo';
import { ThemeToggle } from '@/components/ThemeToggle';
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
    <header className="ark-surface-faint relative z-10 flex items-center justify-between gap-4 border-b border-overlay/[0.06] px-6 py-3 backdrop-blur-md">
      <div className="flex items-center gap-3">
        <ArkLogo
          className="h-9 text-fg"
          bg={SKY}
          fg={INK_900}
          markOnly
        />
        <div className="leading-tight">
          <div className="font-display text-[0.95rem] font-black tracking-tight text-fg">
            Ark Media
          </div>
          <div className="text-[0.72rem] uppercase tracking-[0.22em] text-fg/45">
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
                ? 'rounded-md bg-sky-brand/[0.12] text-sky-brand-soft'
                : 'text-fg/60 hover:bg-overlay/[0.05] hover:text-fg',
            )}
          >
            Archive
          </Link>
          <Link
            href="/prep"
            className={cn(
              'rounded-md px-2.5 py-1 transition',
              variant === 'prep'
                ? 'bg-sky-brand/[0.12] text-sky-brand-soft'
                : 'text-fg/60 hover:bg-overlay/[0.05] hover:text-fg',
            )}
          >
            Prep
          </Link>
          <Link
            href="/news"
            className={cn(
              'rounded-md px-2.5 py-1 transition',
              variant === 'news'
                ? 'bg-sky-brand/[0.12] text-sky-brand-soft'
                : 'text-fg/60 hover:bg-overlay/[0.05] hover:text-fg',
            )}
          >
            News
          </Link>
        </nav>

        {episodeCount !== undefined ? (
          <div className="hidden items-center gap-2 text-[0.7rem] text-fg/40 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]" />
            <span>{episodeCount ?? '—'} episodes indexed</span>
          </div>
        ) : null}

        <ThemeToggle />
      </div>
    </header>
  );
}
