import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PrepPage from './page';

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    status: 'idle',
    stop: vi.fn(),
    regenerate: vi.fn(),
    clearError: vi.fn(),
    error: null,
  }),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'test-chat-id' }),
}));

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    }),
  );
});

describe('PrepPage - File Attachment Regression Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should attach files when onChange fires (regression: FileList live collection)', async () => {
    render(<PrepPage />);

    const fileInput = await waitFor(() => {
      const el = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (!el) throw new Error('file input not yet rendered');
      return el;
    });

    const testFile = new File(['test content'], 'episode-notes.pdf', { type: 'application/pdf' });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(testFile);

    Object.defineProperty(fileInput, 'files', {
      value: dataTransfer.files,
      writable: false,
    });

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => {
      expect(screen.getByText(/episode-notes\.pdf/)).toBeInTheDocument();
    });
  });

  it('should handle multiple file attachments', async () => {
    render(<PrepPage />);

    const fileInput = await waitFor(() => {
      const el = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (!el) throw new Error('file input not yet rendered');
      return el;
    });

    const file1 = new File(['content1'], 'outline.pdf', { type: 'application/pdf' });
    const file2 = new File(['content2'], 'transcript.txt', { type: 'text/plain' });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file1);
    dataTransfer.items.add(file2);

    Object.defineProperty(fileInput, 'files', {
      value: dataTransfer.files,
      writable: false,
    });

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => {
      expect(screen.getByText(/outline\.pdf/)).toBeInTheDocument();
      expect(screen.getByText(/transcript\.txt/)).toBeInTheDocument();
    });
  });

  it('should display file size information', async () => {
    render(<PrepPage />);

    const fileInput = await waitFor(() => {
      const el = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (!el) throw new Error('file input not yet rendered');
      return el;
    });

    const testFile = new File(['a'.repeat(1024)], 'notes.pdf', { type: 'application/pdf' });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(testFile);

    Object.defineProperty(fileInput, 'files', {
      value: dataTransfer.files,
      writable: false,
    });

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => {
      expect(screen.getByText(/notes\.pdf/)).toBeInTheDocument();
      expect(screen.getByText(/1 KB/)).toBeInTheDocument();
    });
  });
});
