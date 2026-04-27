# Ark News Daily Script Writer

A skill for generating daily news scripts with full sourcing, editorial review, and refinement.

## When to Use

Invoke this skill when you need to:
- Generate a complete 5–10 minute Ark News Daily script from an episode outline + source URLs
- Review generated scripts for voice consistency, source fidelity, and editorial quality
- Refine tone, transitions, or emphasis after generation
- Understand what flags mean and how to resolve them

## The Tool at a Glance

**URL:** `/news` on the internal chatbot

**Input:** Episode outline (text) + source article URLs (pasted or as files)

**Output:** Complete script with three blocks (A/B/C), inline footnotes, review flags, and source list

---

## Deborah Pardes' Voice: What to Expect

Deborah's register across all scripts:

- **Authoritative but conversational** — not academic, not casual. She knows this material deeply.
- **Precise on details** — exact names, titles, dates, numbers. No hedging unless the story itself is uncertain.
- **Driven by reporting** — claims come from sources, not opinion. When she frames something, she's synthesizing multiple reports.
- **Natural pacing for audio** — short sentences, clear pauses (line breaks), no word density that confuses listeners on first hearing.
- **Smooth transitions** — one story flows into the next via a clear logical thread, never jarring.

### Voice Anchors (from real scripts)

From the April 1, 2026 script:
- "It's day 33 of the war with Iran and the United States and Israel are pointing to a scaled down end game." — specific, grounded, authoritative opener.
- "According to the Wall Street Journal, Trump has recently told aides..." — attribution before claim.
- "That has not been confirmed." — flags uncertainty without avoiding the newsworthy claim.
- "This means realignment." — synthesis that lets the listener fill in implications.

---

## Script Structure: Three Blocks

### A BLOCK (~300–400 words)
The lead story. Usually the most significant development of the day.
- Establishes facts and stakes clearly.
- May include 1–2 soundbite clips.
- Ends on a natural pause or pivot.

**Tone:** "Here's what's happening, here's why it matters."

### B BLOCK (~300–400 words)
Second story; often related to A or providing context/consequence. Different angle than A.
- May include soundbites.
- Can pivot away from A if the news requires it.

**Tone:** "Now here's the next piece of this story" or "Separately, here's another development."

### C BLOCK (~150–250 words)
The shorter close. Often more human-interest, lighter, or a necessary follow-up note.
- Softer pacing, room for brevity.
- Can include show notes (e.g., "Ark Media is off for the rest of the week").

**Tone:** "Before we go..." or "One more thing happening..."

---

## Soundbite Clips: The SPEAKER Format

When a story calls for a direct quote or audio clip, the script uses this format:

```
SPEAKER_NAME:
The text of the quote or clip, as reported.
```

Examples:
```
NETANYAHU:
Eventually, I think this regime will collapse internally.
But at the moment, what we're doing is just degrading their military capacity.

HEGSETH:
You can't fight and win a war if you tell your adversary what you are willing to do.
```

Use the speaker's name in caps. If the speaker is unknown or generic, the system uses SPEAKER_01, SPEAKER_02, etc.

---

## Footnotes and Sources

Every factual claim is tied to a source via an **inline superscript number**:

```
"...the regime could end up weakened, but still standing¹ and still in control of the Strait of Hormuz²."
```

At the end of the script, a numbered source list:

```
SOURCES:

1. Wall Street Journal, "Trump Signals Willingness to End Iran War Without Full Victory," April 2026 — https://wsj.com/...
2. CBS News, Interview with Trump, April 1, 2026 — https://cbsnews.com/...
```

**Your job as editor:**
- Verify each superscript number matches the source list.
- Spot-check claims against the sources.
- Flag any claim that seems to rely on an weak or unclear source.

---

## Review Flags: What They Mean

The script includes inline `[FLAG: ...]` markers when:
- A claim is uncertain or unconfirmed.
- A source is weak, unclear, or biased.
- A claim relies on inference beyond the source material.
- Chronology is ambiguous or a date is unclear.

Example from real script:
```
According to one Israeli security analyst, the strike may have been intended to bury those stockpiles beyond the regime's reach. [FLAG: unconfirmed; source is Israeli security analyst speculation].
```

**Your job as editor:**
- Read the FLAG carefully. It explains what's uncertain.
- Decide: Is this newsworthy despite the flag? Does it need a source fix or a rewrite?
- Remove the flag if you've confirmed the claim with a stronger source.
- Keep the flag if the uncertainty itself is part of the story ("X claims, but it's unconfirmed").

---

## Editorial Workflow: Refinement

### First Turn: Generate
You submit an outline + article URLs. The system generates a complete script.

### Second Turn: Refine (Paste Back)
Once you have the script, you can refine it by pasting it back with a refinement request:

**Examples of refinement prompts:**
- "Make the C block warmer and more human."
- "Tighten the transition from A to B. They feel disconnected."
- "The B block is too dense. Can you simplify the arms sales paragraph?"
- "Does the Trump quote in the A block need more context?"

The system will return a revised script in the same format.

### Refinement Checklist

Before approving a final script, ask yourself:

**Voice:**
- [ ] Does this sound like Deborah? (Authoritative, precise, conversational)
- [ ] Are transitions smooth? (No jarring pivots between blocks)
- [ ] Is pacing natural for audio? (Can someone follow it on first hearing?)

**Sources:**
- [ ] Every superscript footnote maps to the source list?
- [ ] Every flagged claim — do I understand why it's flagged?
- [ ] Are quotes accurate and attributed correctly?

**Accuracy:**
- [ ] Names, titles, dates, numbers are correct?
- [ ] No inference beyond the sources?
- [ ] Chronology is clear?

**Structure:**
- [ ] A block is the clear lead?
- [ ] B block adds meaningful context or consequence?
- [ ] C block feels like a natural close?

---

## Common Editing Moves

### Tightening a Dense Block
If a block (usually B) has too much information:
- Identify the three most important claims.
- Ask the model to "Focus the B block on X, Y, Z only. Cut the rest."

### Flagged Claims
If a claim is flagged as unconfirmed but you've found better sourcing:
- Note the new source to the model.
- Ask it to remove the flag and cite the new source.

### Smoothing a Transition
If A→B feels abrupt:
- Note the issue: "The A block ends on geopolitical strategy. The B block starts with arms sales. The jump feels disconnected."
- Ask for a bridge: "Add 2–3 sentences at the start of the B block that connect the strategy pivot to the arms sales announcement."

### Softening a Cold Close
If the C block feels like a list of facts rather than a natural sign-off:
- Note it: "The C block reads like a news ticker. Deborah's voice softens toward the close — this should feel like reflection, not data."
- Ask for a rewrite: "Rewrite the C block with a warmer tone, like Deborah is reflecting on what this means for Israelis celebrating Passover under these conditions."

---

## What the Model Won't Do (and What You Will)

The model generates scripts grounded in sources, flags uncertainty, and follows voice/structure rules. **You** do the human editorial judgment:

- Deciding if a flagged claim is newsworthy despite uncertainty.
- Choosing which three stories matter most for today.
- Approving tone changes and refinements.
- Fact-checking against sources (spot checks).
- Final quality pass before Deborah records.

---

## Quick Start

1. **Go to `/news`** on the internal chatbot.
2. **Write an outline** naming your three main stories (A, B, C), optionally with key angles.
3. **Paste source URLs** into the same textarea (or attach files with article text/PDFs).
4. **Hit Send.** The model fetches articles, retrieves style examples from prior Ark News Daily scripts, and generates a draft.
5. **Review** using the checklist above.
6. **Refine** if needed by pasting the script back with a refinement request.
7. **Approve** when voice, sources, and accuracy all check out.

---

## Further Reading

See `/CLAUDE.md` for the full system prompt and tool definitions.
