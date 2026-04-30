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
import { parseCitations } from '@/lib/citation-parser';

type Ctx = {
  sources: Map<string, Source>;
  onOpen: (s: Source, quote?: string) => void;
  keyRef: { n: number };
  today: Date;
};

function splitCitations(text: string, ctx: Ctx): ReactNode[] {
  return parseCitations(text).map((token) => {
    if (token.type === 'text') return token.text;
    const key = `${token.kind}:${token.id}`;
    return (
      <Citation
        key={`cit-${ctx.keyRef.n++}`}
        kind={token.kind}
        id={token.id}
        source={ctx.sources.get(key)}
        quote={token.quote}
        onOpen={ctx.onOpen}
        today={ctx.today}
      />
    );
  });
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
  onOpen: (source: Source, quote?: string) => void;
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
