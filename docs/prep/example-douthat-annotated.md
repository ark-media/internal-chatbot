# Example prep doc — annotated with but/therefore connectors

This is the Douthat prep doc classified through the but/therefore lens. Use this as the one-shot example in the prep agent system prompt so the model learns what a well-connected question arc looks like *and* hears Dan's voice: long contextualizing setups, concrete historical references (Buchanan '92), quoting the guest's prior work ("on Jonah Goldberg's podcast you said..."), and willingness to stake out a disagreement.

## The arc

| # | Connector | Question (short form) | What it does |
|---|-----------|------------------------|--------------|
| 1 | **[open]** | Current state of the war | Establishes the baseline. The opener has nothing to build on yet. |
| 2 | **[therefore]** | Given the war accelerates politics — Feb 27 vs. Apr 22, what's changed? | Flows directly from Q1: if we've just mapped the state, the next logical step is delta since the war began. |
| 3 | **[but]** | You said on Jonah Goldberg's podcast: "this war is a big risk from the point of view of Zionist conservatism." Define the risk. | Pivots from the public-opinion frame to a specific provocation the guest already put on record. Introduces tension the guest has to defend. |
| 4 | **[but]** | Antisemitism on the Left is the clear story. But it's rising on the Right too. How pervasive, how permanent? | The host is pivoting against his own prior framing — "I've been more focused on the left, but Ross thinks I'm missing something on the right." Sets up the disagreement that becomes the spine of the interview. |
| 5 | **[therefore]** | Is it a quantitative change or substantive? Has it morphed? | Drills into Q4. Takes "it's rising" and forces a more precise answer. |
| 6 | **[but]** | If 90% of Tucker Carlson overlaps with Rashida Tlaib — could the far right and far left align against Jews? | Flips the frame again: instead of treating right and left as separate problems, collapses them into one possible horseshoe. The biggest pivot in the doc. |
| 7 | **[therefore]** | Given everything above — how does the Iran War recalculate the post-Trump Republican future? | Synthesis. Every prior answer feeds in. Closes the arc by forcing the guest to project forward. |

## What makes these questions work (beyond the connectors)

- **Voice and specificity.** Q3 quotes a specific thing the guest said on a specific other podcast. Q6 quotes a specific pundit. This is harder than generic questions but makes the guest defend/elaborate rather than recite.
- **Stakeholding.** The host isn't a neutral reader. Dan says, in effect, "I disagree with you — I think the right isn't the real problem." That disagreement is the fuel for Qs 4–6.
- **Historical anchors.** Dan invokes Pat Buchanan 1992, the Iraq War, and the Buchanan–Bush primary as sparring partners. The model should feel free to pull in historical parallels when the topic invites them.
- **Length and shape.** Opener + 6 follow-ups = 7. Some questions have two-sentence setups; some are one sentence. Don't force uniform length.
- **No "and then" pivots.** Nowhere does the doc go "Okay, moving on to a new topic." Every question is either building or challenging.
