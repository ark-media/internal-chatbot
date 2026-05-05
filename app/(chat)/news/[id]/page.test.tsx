import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import NewsPage from './page';

// Mock the useChat hook
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    status: 'idle',
    stop: vi.fn(),
  }),
}));

// Mock useParams so the chat-id gate resolves; mock fetch so initial-message
// loading completes immediately with an empty list.
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

describe('NewsPage - File Attachment Regression Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should attach files when onChange fires (regression: FileList live collection)', async () => {
    render(<NewsPage />);

    // Get the hidden file input
    const fileInput = await waitFor(() => {
      const el = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (!el) throw new Error('file input not yet rendered');
      return el;
    });

    // Create a test file
    const testFile = new File(['test content'], 'article.md', { type: 'text/markdown' });

    // Create a proper DataTransfer object and set files
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(testFile);

    // Set the files property (this will trigger onChange when we fire the event)
    Object.defineProperty(fileInput, 'files', {
      value: dataTransfer.files,
      writable: false,
    });

    // Trigger onChange event
    const changeEvent = new Event('change', { bubbles: true });
    fileInput.dispatchEvent(changeEvent);

    // The file should now appear in the UI
    // This test passes if the file appears without error (the regression was that files disappeared)
    await waitFor(() => {
      expect(screen.getByText(/article\.md/)).toBeInTheDocument();
    });
  });

  it('should show success message when files are attached', async () => {
    render(<NewsPage />);

    const fileInput = await waitFor(() => {
      const el = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (!el) throw new Error('file input not yet rendered');
      return el;
    });
    const testFile = new File(['content'], 'outline.txt', { type: 'text/plain' });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(testFile);

    Object.defineProperty(fileInput, 'files', {
      value: dataTransfer.files,
      writable: false,
    });

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Success message should appear
    await waitFor(() => {
      expect(screen.getByText(/1 file attached/)).toBeInTheDocument();
    });
  });

  it('should handle multiple file attachments', async () => {
    render(<NewsPage />);

    const fileInput = await waitFor(() => {
      const el = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (!el) throw new Error('file input not yet rendered');
      return el;
    });
    const file1 = new File(['content1'], 'article1.txt', { type: 'text/plain' });
    const file2 = new File(['content2'], 'article2.txt', { type: 'text/plain' });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file1);
    dataTransfer.items.add(file2);

    Object.defineProperty(fileInput, 'files', {
      value: dataTransfer.files,
      writable: false,
    });

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Both files should appear
    await waitFor(() => {
      expect(screen.getByText(/article1\.txt/)).toBeInTheDocument();
      expect(screen.getByText(/article2\.txt/)).toBeInTheDocument();
    });

    // Success message should show count
    await waitFor(() => {
      expect(screen.getByText(/2 files attached/)).toBeInTheDocument();
    });
  });

  it('should display file size information', async () => {
    render(<NewsPage />);

    const fileInput = await waitFor(() => {
      const el = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (!el) throw new Error('file input not yet rendered');
      return el;
    });
    const testFile = new File(['a'.repeat(1024)], 'large.txt', { type: 'text/plain' }); // 1KB file

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(testFile);

    Object.defineProperty(fileInput, 'files', {
      value: dataTransfer.files,
      writable: false,
    });

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    // File and size should be visible
    await waitFor(() => {
      expect(screen.getByText(/large\.txt/)).toBeInTheDocument();
      expect(screen.getByText(/1 KB/)).toBeInTheDocument();
    });
  });
});
