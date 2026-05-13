import { cn } from '@/lib/cn';

type Props = {
  className?: string;
  /** When true, render only the mark (no text). */
  markOnly?: boolean;
  /** Background of the circular container. Defaults to brand navy. */
  bg?: string;
  /** Color of the mark itself. Defaults to white. */
  fg?: string;
};

/**
 * Stylised rendering of the Ark Media mark:
 * a circular container holding an iceberg peak and two wave lines.
 */
export function ArkLogo({
  className,
  markOnly = true,
  bg = '#0b153c',
  fg = '#ffffff',
}: Props) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg
        viewBox="0 0 64 64"
        role="img"
        aria-label="Ark Media"
        className="h-full w-auto shrink-0"
      >
        <circle cx="32" cy="32" r="31" fill={bg} />
        {/* Iceberg peak – irregular polygon, split highlight */}
        <path
          d="M32.5 13.5 L22.4 34 L30.4 32.4 L34.1 36 L43.6 34.6 Z"
          fill={fg}
        />
        {/* Inner shadow slash, gives the peak its faceted look */}
        <path
          d="M32.5 13.5 L30.4 32.4 L28.2 33.1 Z"
          fill={bg}
          opacity="0.55"
        />
        {/* Upper wave */}
        <path
          d="M16 42 C 22 38, 42 38, 48 42"
          stroke={fg}
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
        />
        {/* Lower wave, slightly offset */}
        <path
          d="M13 49 C 22 44, 42 44, 51 49"
          stroke={fg}
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      {!markOnly && (
        <span
          className="font-display text-[1.1em] font-black tracking-tight text-fg"
          style={{ letterSpacing: '-0.01em' }}
        >
          Ark Media
        </span>
      )}
    </span>
  );
}
