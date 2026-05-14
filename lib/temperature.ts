// Shared temperature-preset registry. Imported by both server (api/news +
// api/prep route handlers) and client (TemperatureSelector.tsx) — keep this
// module free of `'use client'` directives and server-only deps so it works
// in both contexts. Mirrors the pattern in lib/models.ts.
//
// The client sends a preset *id* (the `x-temperature` header), never a raw
// number, so the actual temperature values stay authoritative here on the
// server and can't be arbitrarily injected.

export type TemperaturePresetId = 'precise' | 'balanced' | 'standard' | 'creative';

export type TemperaturePreset = {
  id: TemperaturePresetId;
  label: string;
  value: number;
  hint: string;
};

export const TEMPERATURE_PRESETS: TemperaturePreset[] = [
  { id: 'precise', label: 'Precise', value: 0.0, hint: 'Facts, quotes, fact-checking' },
  { id: 'balanced', label: 'Balanced', value: 0.3, hint: 'Even-handed — the news default' },
  { id: 'standard', label: 'Standard', value: 0.5, hint: 'A touch more variety — the prep default' },
  { id: 'creative', label: 'Creative', value: 0.8, hint: 'Titles, ideas, brainstorming' },
];

// Per-surface starting presets. These match each surface's pre-existing fixed
// temperature exactly (news was 0.3, prep was 0.5) so making temperature
// configurable does not change default behavior — it only adds new options.
export const NEWS_DEFAULT_TEMPERATURE_PRESET: TemperaturePresetId = 'balanced';
export const PREP_DEFAULT_TEMPERATURE_PRESET: TemperaturePresetId = 'standard';

const FALLBACK_PRESET = TEMPERATURE_PRESETS.find((p) => p.id === 'balanced')!;

// Resolve a preset id (e.g. from the `x-temperature` header) to its numeric
// temperature. Unknown / missing ids fall back to Balanced rather than
// throwing — a malformed header should degrade gracefully, not 500.
export function resolveTemperature(presetId: string | null | undefined): number {
  if (!presetId) return FALLBACK_PRESET.value;
  return (
    TEMPERATURE_PRESETS.find((p) => p.id === presetId)?.value ?? FALLBACK_PRESET.value
  );
}
