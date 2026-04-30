'use client';

import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Source } from './chat-types';
import { Citation } from './Citation';

// Match any bracket that contains at least one id:N or turn:N reference.
// Examples handled:
//   [id:1]                       → 1 chip
//   [id:1,2,3]                   → 3 chips
//   [turn:4, 5]                  → 2 chips
//   [turn:8368, id:2985]         → 2 chips (mixed kinds in one bracket)
//   [id:1, turn:2,3]             → 3 chips
const BRACKET_RE = /\[[^\]]*(?:id|turn):\s*\d+[^\]]*\]/g;
const INNER_RE = /(id|turn):\s*(\d+(?:\s*,\s*\d+)*)/g;

type Ctx = {
  sources: Map<string, Source>;
  onOpen: (s: Source) => void;
  keyRef: { n: number };
  today: Date;
};

function splitCitations(text: string, ctx: Ctx): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let bracket: RegExpExecArray | null;
  BRACKET_RE.lastIndex = 0;
  while ((bracket = BRACKET_RE.exec(text)) !== null) {
    if (bracket.index > lastIndex) {
      nodes.push(text.slice(lastIndex, bracket.index));
    }
    const inner = bracket[0];
    INNER_RE.lastIndex = 0;
    let ref: RegExpExecArray | null;
    while ((ref = INNER_RE.exec(inner)) !== null) {
      const [, kind, idsStr] = ref;
      const ids = idsStr
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      for (const id of ids) {
        const key = `${kind}:${id}`;
        nodes.push(
          <Citation
            key={`cit-${ctx.keyRef.n++}`}
            kind={kind as 'id' | 'turn'}
            id={id}
            source={ctx.sources.get(key)}
            onOpen={ctx.onOpen}
            today={ctx.today}
          />,
        );
      }
    }
    lastIndex = bracket.index + bracket[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function walk(children: ReactNode, ctx: Ctx): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === 'string') {
      return splitCitations(child, ctx);
    }
    if (isValidElement(child)) {
      const element = child as ReactElement<{ children?: ReactNode }>;
      const inner = element.props.children;
      if (inner == null) return element;
      return cloneElement(element, undefined, walk(inner, ctx));
    }
    return child;
  });
}

type Props = {
  text: string;
  sources: Map<string, Source>;
  onOpen: (source: Source) => void;
};

export function MessageText({ text, sources, onOpen }: Props) {
  // One Date per message render so all chips agree on the year boundary,
  // even if the user has the page open across midnight.
  const today = new Date();
  const ctx: Ctx = { sources, onOpen, keyRef: { n: 0 }, today };

  return (
    <div className="ark-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{walk(children, ctx)}</p>,
          li: ({ children }) => <li>{walk(children, ctx)}</li>,
          strong: ({ children }) => <strong>{walk(children, ctx)}</strong>,
          em: ({ children }) => <em>{walk(children, ctx)}</em>,
          h1: ({ children }) => <h1>{walk(children, ctx)}</h1>,
          h2: ({ children }) => <h2>{walk(children, ctx)}</h2>,
          h3: ({ children }) => <h3>{walk(children, ctx)}</h3>,
          h4: ({ children }) => <h4>{walk(children, ctx)}</h4>,
          blockquote: ({ children }) => (
            <blockquote>{walk(children, ctx)}</blockquote>
          ),
          td: ({ children }) => <td>{walk(children, ctx)}</td>,
          th: ({ children }) => <th>{walk(children, ctx)}</th>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {walk(children, ctx)}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
