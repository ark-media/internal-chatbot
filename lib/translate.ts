import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

// Simple language detection: check for Hebrew Unicode ranges
function detectHebrewContent(text: string): boolean {
  const hebrewRegex = /[֐-׿]/g;
  const hebrewChars = text.match(hebrewRegex) || [];
  // If >10% of text is Hebrew characters, treat as Hebrew
  return hebrewChars.length / text.length > 0.1;
}

export async function ensureEnglish(text: string): Promise<string> {
  if (!detectHebrewContent(text)) {
    return text;
  }

  try {
    const { text: translated } = await generateText({
      model: anthropic('claude-opus-4-7'),
      prompt: `Translate the following Hebrew text to English. Preserve all factual details, dates, names, and quotes exactly. Return only the translation, no explanations.\n\n${text}`,
    });

    return translated;
  } catch (err) {
    // On translation error, return original text and let the script writer flag uncertainty
    console.error('Translation failed:', err);
    return text;
  }
}
