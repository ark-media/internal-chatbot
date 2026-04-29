'use client';

import { useRef, useState, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export const MODELS = [
  {
    id: 'anthropic/claude-haiku-4-5',
    name: 'Claude Haiku',
    description: 'Fast and lightweight. Best for quick answers.',
  },
  {
    id: 'anthropic/claude-sonnet-4-6',
    name: 'Claude Sonnet',
    description: 'Balanced speed and intelligence. Recommended.',
  },
  {
    id: 'anthropic/claude-opus-4-7',
    name: 'Claude Opus',
    description: 'Most capable. Best for complex reasoning.',
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    description: 'OpenAI\'s latest. Excellent all-around performance.',
  },
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    description: 'High capability with lower latency.',
  },
  {
    id: 'google/gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    description: 'Google\'s fast and efficient model.',
  },
  {
    id: 'google/gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    description: 'Google\'s most capable model for complex tasks.',
  },
];

type ModelSelectorProps = {
  selectedModel: string;
  onModelChange: (modelId: string) => void;
};

export function ModelSelector({ selectedModel, onModelChange }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 h-10',
          'bg-white/[0.05] text-[0.85rem] text-white/70 transition',
          'hover:bg-white/[0.08] hover:text-white',
          'border border-white/10 whitespace-nowrap',
        )}
      >
        {MODELS.find((m) => m.id === selectedModel)?.name}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 w-56 rounded-lg border border-white/10 bg-[#0f1428]/95 py-1.5 shadow-lg backdrop-blur-md z-50">
          {MODELS.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => {
                onModelChange(model.id);
                setIsOpen(false);
              }}
              className={cn(
                'w-full px-3 py-2 text-left transition',
                selectedModel === model.id
                  ? 'bg-[#3eb5f9]/20 text-[#79cdfc]'
                  : 'text-white/70 hover:bg-white/[0.05] hover:text-white',
              )}
            >
              <div className="font-medium text-[0.9rem]">{model.name}</div>
              <div className="mt-0.5 text-[0.75rem] text-white/50">
                {model.description}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
