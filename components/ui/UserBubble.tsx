'use client';

import type { ReactNode } from 'react';
import { Pencil } from 'lucide-react';

import { cn } from '@/lib/cn';

// The right-aligned user message bubble, with a hover-revealed edit control.
//
// `files` is a slot rather than a prop shape because each surface renders
// attachments differently (chat has none, news a bare filename, prep a
// FileText chip). The hover reveal depends on `group`/`group-hover` staying in
// the same component as the button — don't split them.
export function UserBubble({
  textParts,
  files,
  isEditing,
  onEdit,
}: {
  textParts: string[];
  files?: ReactNode;
  isEditing?: boolean;
  onEdit?: () => void;
}) {
  return (
    <div className="ark-fade-up flex justify-end gap-2 items-start group">
      <div
        className={cn(
          'max-w-[82%] rounded-2xl rounded-br-md px-4 py-2.5',
          'bg-gradient-to-br from-sky-brand to-sky-brand-deep text-ink-950',
          'shadow-[0_8px_22px_-10px_rgba(62,181,249,0.6)]',
          'text-[0.95rem] font-medium leading-relaxed',
          'transition-all duration-200',
          isEditing && 'ring-2 ring-blue-400/50 shadow-[0_8px_22px_-10px_rgba(59,130,246,0.5)]',
        )}
      >
        {textParts.map((text, i) => (
          <span key={i} className="whitespace-pre-wrap">
            {text}
          </span>
        ))}
        {files}
      </div>
      {onEdit ? (
        <button
          onClick={onEdit}
          className={cn(
            'mt-1 p-1.5 rounded-lg transition-all opacity-0 group-hover:opacity-100 duration-200',
            isEditing
              ? 'bg-blue-400/20 text-blue-300 hover:bg-blue-400/30'
              : 'hover:bg-overlay/10 text-fg/50 hover:text-fg/70',
          )}
          title="Edit message (or click to edit)"
        >
          <Pencil className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
