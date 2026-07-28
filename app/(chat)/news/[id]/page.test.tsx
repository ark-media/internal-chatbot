import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import NewsPage from './page';
import { attachFiles, stubEmptyChatFetch } from '@/test-helpers/chat-page';

// Mock the useChat hook
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    status: 'idle',
    stop: vi.fn(),
  }),
}));

// Mock useParams so the chat-id gate resolves; the fetch stub below lets
// initial-message loading complete immediately with an empty list.
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'test-chat-id' }),
}));

beforeEach(stubEmptyChatFetch);

describe('NewsPage - File Attachment Regression Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should attach files when onChange fires (regression: FileList live collection)', async () => {
    render(<NewsPage />);
    await attachFiles(new File(['test content'], 'article.md', { type: 'text/markdown' }));

    // Passes if the file appears without error — the regression was that
    // files disappeared entirely.
    await waitFor(() => {
      expect(screen.getByText(/article\.md/)).toBeInTheDocument();
    });
  });

  it('should show success message when files are attached', async () => {
    render(<NewsPage />);
    await attachFiles(new File(['content'], 'outline.txt', { type: 'text/plain' }));

    await waitFor(() => {
      expect(screen.getByText(/1 file attached/)).toBeInTheDocument();
    });
  });

  it('should handle multiple file attachments', async () => {
    render(<NewsPage />);
    await attachFiles(
      new File(['content1'], 'article1.txt', { type: 'text/plain' }),
      new File(['content2'], 'article2.txt', { type: 'text/plain' }),
    );

    await waitFor(() => {
      expect(screen.getByText(/article1\.txt/)).toBeInTheDocument();
      expect(screen.getByText(/article2\.txt/)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText(/2 files attached/)).toBeInTheDocument();
    });
  });

  it('should display file size information', async () => {
    render(<NewsPage />);
    await attachFiles(new File(['a'.repeat(1024)], 'large.txt', { type: 'text/plain' }));

    await waitFor(() => {
      expect(screen.getByText(/large\.txt/)).toBeInTheDocument();
      expect(screen.getByText(/1 KB/)).toBeInTheDocument();
    });
  });
});
