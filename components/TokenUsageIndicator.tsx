'use client';

import type { UsageData } from '@/components/chat-types';
import { cn } from '@/lib/cn';

type TokenUsageIndicatorProps = {
  usage: UsageData;
  className?: string;
};

export function TokenUsageIndicator({
  usage,
  className,
}: TokenUsageIndicatorProps) {
  const { inputTokens, outputTokens, cachedInputTokens, contextWindow } = usage;
  const totalUsed = inputTokens + outputTokens;
  const percentUsed = (totalUsed / contextWindow) * 100;

  const formatNumber = (n: number): string => {
    if (n >= 1000) {
      return `${(n / 1000).toFixed(1)}k`;
    }
    return n.toString();
  };

  return (
    <div
      className={cn(
        'ark-surface flex items-center gap-3 rounded-lg border border-overlay/10 px-3 py-2 text-xs text-fg/60',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{formatNumber(totalUsed)}</span>
        <span className="text-fg/30">/</span>
        <span>{formatNumber(contextWindow)}</span>
      </div>

      <div className="h-5 w-16 rounded bg-overlay/5 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-cyan-400/60 to-blue-400/60 transition-all duration-300"
          style={{ width: `${Math.min(percentUsed, 100)}%` }}
        />
      </div>

      <span className="text-fg/40">{percentUsed.toFixed(1)}%</span>

      {cachedInputTokens > 0 && (
        <>
          <span className="text-fg/20">·</span>
          <span className="text-emerald-300/70" title="Cached input tokens">
            ~{formatNumber(cachedInputTokens)} cached
          </span>
        </>
      )}
    </div>
  );
}
