// @vitest-environment jsdom
// This suite renders the page; everything else in the repo runs in node.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PrepPage from './page';
import { attachFiles, stubEmptyChatFetch } from '@/test-helpers/chat-page';

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

beforeEach(stubEmptyChatFetch);

describe('PrepPage - File Attachment Regression Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should attach files when onChange fires (regression: FileList live collection)', async () => {
    render(<PrepPage />);
    await attachFiles(
      new File(['test content'], 'episode-notes.pdf', { type: 'application/pdf' }),
    );

    await waitFor(() => {
      expect(screen.getByText(/episode-notes\.pdf/)).toBeInTheDocument();
    });
  });

  it('should handle multiple file attachments', async () => {
    render(<PrepPage />);
    await attachFiles(
      new File(['content1'], 'outline.pdf', { type: 'application/pdf' }),
      new File(['content2'], 'transcript.txt', { type: 'text/plain' }),
    );

    await waitFor(() => {
      expect(screen.getByText(/outline\.pdf/)).toBeInTheDocument();
      expect(screen.getByText(/transcript\.txt/)).toBeInTheDocument();
    });
  });

  it('should display file size information', async () => {
    render(<PrepPage />);
    await attachFiles(new File(['a'.repeat(1024)], 'notes.pdf', { type: 'application/pdf' }));

    await waitFor(() => {
      expect(screen.getByText(/notes\.pdf/)).toBeInTheDocument();
      expect(screen.getByText(/1 KB/)).toBeInTheDocument();
    });
  });
});
