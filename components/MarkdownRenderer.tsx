'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';
import type { Components } from 'react-markdown';

type Props = {
  text: string;
  components?: Partial<Components>;
  className?: string;
};

const defaultComponents: Partial<Components> = {
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  h1: ({ children }) => <h1 className="text-2xl font-bold my-4 mt-5">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xl font-bold my-3 mt-4">{children}</h2>,
  h3: ({ children }) => <h3 className="text-lg font-bold my-2 mt-3">{children}</h3>,
  h4: ({ children }) => <h4 className="text-base font-bold my-2 mt-2 uppercase tracking-wide">{children}</h4>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-white/30 pl-4 my-3 italic text-white/80">{children}</blockquote>
  ),
  ul: ({ children }) => <ul className="list-disc list-inside my-2 ml-2">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside my-2 ml-2">{children}</ol>,
  li: ({ children }) => <li className="my-1">{children}</li>,
  hr: () => <hr className="my-4 border-white/20" />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 underline">
      {children}
    </a>
  ),
};

export function MarkdownRenderer({ text, components = {}, className = '' }: Props) {
  const mergedComponents: Partial<Components> = { ...defaultComponents, ...components };

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mergedComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
