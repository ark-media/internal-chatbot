# Ark Internal Chatbot — User Guide

A single chat surface with three modes: **Archive**, **Prep**, and **News**. Switch between them in the left sidebar.

Even though Prep and News generate a fully-formed document on the first message, all three modes are real chatbots — keep talking to refine, expand, or replace what they produced. You don't need to start over.

---

## The sidebar (chats are saved for 7 days)

- The left sidebar lists your saved chats, grouped by mode (Archive / Prep / News).
- Click any chat to reopen it — the full thread, sources, and refinements are preserved.
- Hover a chat and click the trash icon to delete it. Otherwise chats are auto-purged 7 days after their last message.
- "New chat" starts a fresh thread in whichever mode you're viewing.

> If you generated a script or prep doc you'll want to keep, **Save to Drive** before the 7-day window closes (more on that below).

---

## 1. Archive — ask the transcripts

The Archive is a RAG chatbot over the Ark Media podcast back-catalog (every episode that's been ingested into the corpus). Every answer is grounded in transcript excerpts and cited — if it can't find support, it tells you instead of making something up.

Use it when you want to know:

- *Who said what, when, on which show*
- *How a guest's view has shifted over time*
- *Whether two hosts contradict each other*
- *Every appearance a given guest has made*

### Example

> **You:** What has Nadav Eyal said about the Houthis recently?
>
> **Archive:** *(retrieves excerpts, then answers with inline citations like `[id:4821]` you can click to open the source panel)*
>
> **You:** Limit that to the last three months and group it by what he thinks Israel should do about it.

That second message is the point — Archive isn't a search box, it's a conversation. Push back, narrow the scope, ask for tables, ask "did anyone disagree with him?" The retrieved sources stay visible in the side panel for the whole thread.

---

## 2. Prep — interview questions

Prep is built primarily for **Call me Back**, but it works for any Ark show. Give it an episode title and a guest, and it returns 6–7 questions, each tagged `[open]`, `[therefore]`, or `[but]` — questions that build on or pivot from the previous answer rather than just stacking topics.

### Example first prompt

```
Call me Back — "Iran after the strikes" — with Ray Takeyh
```

It will research the guest (past appearances on Ark shows, recent public statements via web search) and produce a numbered question list.

### It's still a conversation

The first response is a complete prep doc, but treat it as a draft. Talk to it:

- *"Q3 is too soft — sharpen the challenge."*
- *"Drop the question on sanctions and replace it with one on Saudi-Iran rapprochement."*
- *"Give me a second version of the opener that's warmer and less confrontational."*
- *"Add two follow-ups for if he says X."*

You can also offer two question forms for the same beat ("a sharper version and a warmer version") and pick on the day.

### Attaching prep notes

Use the paperclip icon to attach background docs — past transcripts, op-eds, draft outlines, briefing notes. Up to 10 files, 10 MB each, 25 MB total. PDFs, markdown, plain text, CSVs, JSON, and images are all accepted.

### Save to Drive

When you're happy, click **Save to Drive**. The doc lands in the per-show prep folder:

| Show | Folder |
| --- | --- |
| Call me Back | *Call me Back* prep folder |
| Inside Call me Back | *Inside Call me Back* prep folder |
| For Heaven's Sake | *For Heaven's Sake* prep folder |
| What's Your Number? | *What's Your Number?* prep folder |
| Anything else | Default *Prep* folder |

The show is detected from your first prompt (the part before the first em-dash, en-dash, or hyphen). The filename is `{Show} Prep — {YYYY-MM-DD} — {episode title}`. The success banner shows which folder it landed in, with an "Open" link.

### Copy to Clipboard

If you'd rather paste it into a different doc, **Copy to Clipboard** copies the full questions text verbatim.

---

## 3. News — Ark News Daily scripts

News is **only** for generating Ark News Daily scripts. Don't use it for anything else — the system prompt, retrieval, and output format are all specifically tuned for that show.

Give it an outline with the lead, B block, and C block, plus the article links you want it to use as sources. It will fetch the articles (via Tavily, including paywalled and X/Twitter URLs), pull style examples from prior Ark News Daily scripts, and produce a complete script with `[A BLOCK]` / `[B BLOCK]` / `[C BLOCK]` headers, speaker lines, footnoted citations, and a `SOURCES:` block at the bottom.

### Example outline

```
Outline:
Lead — Trump signals end to Iran War.
B Block — New Middle East realignment.
C Block — Passover under bombardment.
Sources: WSJ, CBS, Times of Israel
```

You can drop bare URLs straight into the prompt, or attach articles as files via the paperclip.

### Refinement chips

After the first script lands, a row of one-click refinement prompts appears under the output:

- *Tighten the B block and cut unnecessary detail.*
- *Make the C block warmer and more reflective.*
- *Smooth the transition from A to B — they feel disconnected.*
- *Strengthen the opening to be more compelling.*

These are starting points, not the whole menu. You can also just type — *"swap the lead and B block,"* *"rewrite the C block in Dan's voice,"* *"add a beat about the EU response,"* *"trim the whole thing by 30 seconds."*

### Save to Drive

**Save to Drive** uploads the script to the **Ark News Daily** Drive folder. The filename is the headline pulled from the A block opener, prefixed with today's date. The success banner gives you an "Open" link.

### Copy to Clipboard

Copies the entire script — block headers, speaker lines, footnotes, sources block.

---

## Switching the model

The dropdown to the left of the message box picks which model writes the next reply. The selection is per-message, so you can mix models in a single thread.

| Model | When to reach for it |
| --- | --- |
| **Claude Sonnet** *(default)* | Balanced. Use this unless you have a specific reason not to. |
| **Claude Haiku** | Faster and cheaper. Good for quick refinements ("tighten this paragraph") or when you're iterating rapidly. Less reliable on long, multi-source reasoning. |
| **Claude Opus** | Most capable. Best for the genuinely hard calls — gnarly comparison questions in Archive, or a Prep doc where the guest's positions are tangled and contradictory. Slower and more expensive. |
| **GPT-4o / GPT-4 Turbo** | OpenAI's frontier models. Useful as a second opinion or when a Claude model is being stubborn. Voice and prose style differ — worth knowing for News. |
| **Gemini 2.0 Flash / 1.5 Pro** | Google's options. Flash is fast; Pro is for longer-context tasks. |

### Things to know

- **Switching mid-thread is fine.** The chat history goes to whichever model you pick next, so you can draft on Sonnet and have Opus do a final polish pass.
- **Voice consistency suffers when you switch.** If you wrote a News script on Sonnet and ask Opus to "tighten the B block," the rewritten block may not match the rest of the script's cadence. For tight refinements, stay on the model that wrote the original.
- **Tool reliability differs.** All listed models can call the corpus search, web search, and article-fetch tools, but Claude models are most consistently accurate at citing back into Ark transcripts. If you see uncited claims or sloppy footnotes, switch back to Sonnet or Opus.
- **Cost and speed scale together.** Haiku → Sonnet → Opus is roughly fast/cheap → balanced → slow/expensive. Same shape for Flash → Pro on Gemini.

---

## Quick reference

| Need to… | Where | How |
| --- | --- | --- |
| Ask about past episodes | Archive | Type a question — answers are cited |
| Generate interview questions | Prep | `Show — "Title" — with Guest` |
| Generate an Ark News Daily script | News | Outline + article links |
| Refine the output | Any mode | Just keep typing — it's a chatbot |
| Attach background docs | Prep, News | Paperclip icon (≤10 files, ≤10 MB each, ≤25 MB total) |
| Save the result | Prep, News | **Save to Drive** — lands in show-specific folder |
| Reopen earlier work | Sidebar | Chats persist for 7 days |
| Try a stronger model | Any mode | Model dropdown left of the message box |
