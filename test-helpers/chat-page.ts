import { vi } from 'vitest';
import { waitFor } from '@testing-library/react';

// Stubs fetch so the initial-message load resolves immediately with an empty
// thread, letting the chat-id gate render the page body.
export function stubEmptyChatFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    }),
  );
}

// Drives the hidden file input the way a real picker does: set `files`, then
// dispatch change. FileList is a live collection tied to the input element, so
// the component has to snapshot it synchronously — that is the regression the
// page tests guard, and why these go through a real event rather than calling
// the handler directly.
export async function attachFiles(...files: File[]): Promise<HTMLInputElement> {
  const input = await waitFor(() => {
    const el = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    if (!el) throw new Error('file input not yet rendered');
    return el;
  });

  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);

  Object.defineProperty(input, 'files', {
    value: dataTransfer.files,
    writable: false,
    configurable: true,
  });

  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input;
}
