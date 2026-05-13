import { Fragment, type ReactNode } from 'react';
import { findQuoteSpans } from '@/lib/quote-match';

type Props = {
  text: string;
  // Verbatim substring emitted by the model with [id:N "..."]. When supplied,
  // matched spans are wrapped in <mark> so the exact passage lights up inside
  // the surrounding turn-level highlight. Falls back to plain text on no match.
  quote?: string;
};

export function HighlightedText({ text, quote }: Props): ReactNode {
  if (!quote) return text;
  const spans = findQuoteSpans(text, quote);
  if (!spans || spans.length === 0) return text;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  spans.forEach(([start, end], i) => {
    if (start > cursor)
      nodes.push(<Fragment key={`t${i}`}>{text.slice(cursor, start)}</Fragment>);
    nodes.push(
      <mark
        key={`m${i}`}
        className="rounded-sm bg-sky-brand/35 px-0.5 text-fg shadow-[inset_0_0_0_1px_rgba(62,181,249,0.45)]"
      >
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length)
    nodes.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>);
  return <>{nodes}</>;
}
