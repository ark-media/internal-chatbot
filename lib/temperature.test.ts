import { describe, it, expect } from 'vitest';
import {
  resolveTemperature,
  TEMPERATURE_PRESETS,
  NEWS_DEFAULT_TEMPERATURE_PRESET,
  PREP_DEFAULT_TEMPERATURE_PRESET,
} from './temperature';

describe('resolveTemperature', () => {
  it('maps each known preset id to its value', () => {
    for (const preset of TEMPERATURE_PRESETS) {
      expect(resolveTemperature(preset.id)).toBe(preset.value);
    }
  });

  it('falls back to Balanced (0.3) for a missing header', () => {
    expect(resolveTemperature(null)).toBe(0.3);
    expect(resolveTemperature(undefined)).toBe(0.3);
    expect(resolveTemperature('')).toBe(0.3);
  });

  it('falls back to Balanced (0.3) for an unknown id', () => {
    expect(resolveTemperature('scorching')).toBe(0.3);
    expect(resolveTemperature('0.9')).toBe(0.3);
  });

  it('keeps the pre-existing per-surface defaults unchanged', () => {
    // Making temperature configurable must not shift default behavior:
    // news was fixed at 0.3, prep at 0.5.
    expect(resolveTemperature(NEWS_DEFAULT_TEMPERATURE_PRESET)).toBe(0.3);
    expect(resolveTemperature(PREP_DEFAULT_TEMPERATURE_PRESET)).toBe(0.5);
  });
});
