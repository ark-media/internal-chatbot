'use client';

import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type IconButtonVariant = 'ghost' | 'chip';
export type IconButtonSize = 'sm' | 'md';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: IconButtonVariant;
  size?: IconButtonSize;
};

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  sm: 'h-8 w-8 rounded-lg',
  md: 'h-10 w-10 rounded-xl',
};

const VARIANT_CLASSES: Record<IconButtonVariant, string> = {
  ghost: 'text-fg/60 hover:bg-overlay/[0.06] hover:text-fg',
  chip:
    'border border-overlay/10 bg-overlay/5 text-fg/60 ' +
    'hover:bg-overlay/10 hover:text-fg',
};

export function IconButton({
  variant = 'ghost',
  size = 'sm',
  className,
  type = 'button',
  ...rest
}: Props) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center transition',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-brand/60',
        'disabled:cursor-not-allowed disabled:opacity-40',
        SIZE_CLASSES[size],
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    />
  );
}
