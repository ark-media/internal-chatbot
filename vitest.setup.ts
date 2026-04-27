import { vi } from 'vitest';
import '@testing-library/jest-dom';

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

    get files() {
      // Create a FileList-like object
      const fileArray = this.items._files;
      return Object.defineProperty(fileArray, 'length', {
        value: fileArray.length,
      }) as any;
    }
  }

  global.DataTransfer = DataTransferPolyfill as any;
}
