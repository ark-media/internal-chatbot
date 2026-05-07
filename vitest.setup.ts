import { vi } from 'vitest';
import '@testing-library/jest-dom';

// Stub DB URL so modules that transitively import `lib/db.ts` (which throws
// at load when DATABASE_URL is missing) can be loaded under test. `neon()`
// doesn't open a connection until a query runs, so a placeholder is safe;
// tests that exercise DB calls should mock those explicitly.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
}

// Mock scrollTo which is not implemented in jsdom
Element.prototype.scrollTo = vi.fn();

// Polyfill DataTransfer which jsdom doesn't fully support
if (typeof global.DataTransfer === 'undefined') {
  class DataTransferPolyfill {
    items = {
      _files: [] as File[],
      add: function(file: File) {
        this._files.push(file);
      },
      clear: function() {
        this._files = [];
      },
    };

    get files(): FileList {
      // Create a FileList-like object
      const fileArray = this.items._files;
      return Object.defineProperty(fileArray, 'length', {
        value: fileArray.length,
      }) as unknown as FileList;
    }
  }

  global.DataTransfer = DataTransferPolyfill as unknown as typeof DataTransfer;
}
