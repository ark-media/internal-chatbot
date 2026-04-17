# Ark Media shows

Concise overviews of each show in the corpus. Used by the query router to decide
which show (if any) a user question is about. Edit this file to update routing
hints — it is loaded at request time and inlined into the router system prompt.

---

## Call me Back
- **Host:** Dan Senor
- **Cadence:** Several times per week; long-form interviews and conversations.
- **Focus:** Israeli politics and security, US–Israel relations, the war in
  Gaza, Iran and the broader Middle East, US foreign policy. Frequent Israeli
  journalists, defense analysts, and political figures as guests.
- **Vocabulary hints:** IRGC, Basij, Quds Force, Hezbollah, Hamas, Fordow,
  Natanz, JCPOA, IDF, Knesset, Mossad, Shin Bet.
- **Route here when:** the question is about Israel, the Middle East, Iran,
  current US–Israel policy, or explicitly mentions Dan Senor or a CMB guest.

## Inside Call me Back
- **Host:** Rotating (spinoff of Call me Back).
- **Focus:** Behind-the-scenes, commentary, and supplementary conversations
  that extend Call me Back episodes. Shorter and more informal.
- **Route here when:** the user mentions "Inside Call me Back" by name, or asks
  about behind-the-scenes / making-of content. When in doubt between the two,
  prefer Call me Back.

## For Heaven's Sake
- **Host:** Donniel Hartman
- **Co-host:** Yossi Klein Halevi
- **Focus:** Jewish thought, Israeli society, religion and peoplehood, moral
  and philosophical questions in the wake of October 7 and the war. Produced
  with the Shalom Hartman Institute.
- **Route here when:** the question is about Jewish identity, religion, ethics,
  moral/philosophical framing of the war, Diaspora–Israel relations, or
  mentions Donniel Hartman or Yossi Klein Halevi.

## What's Your Number?
- **Host:** Yonatan Adiri
- **Co-hosts:** Michal Lev-Ram, Yael Wissner-Levy
- **Focus:** Tech, startups, founders, venture capital, and the Israeli
  innovation ecosystem. Data- and metric-driven framing (hence the name).
- **Route here when:** the question is about tech companies, founders, VC,
  startups, product metrics, or mentions Yonatan Adiri / Michal Lev-Ram /
  Yael Wissner-Levy.

## Ark News Daily
- **Host:** Deborah Pardes
- **Cadence:** Daily, short.
- **Focus:** Daily news briefing covering Israel and the Middle East; quick
  headlines rather than long-form interviews.
- **Route here when:** the user asks about a specific day's news, a short
  update, or phrases the question around "what happened on [date]".

---

## Routing guidance

- If a question fits several shows, pick the most specific. Example: "what did
  Dan Senor say about Iran last week" → `Call me Back`, not `any`.
- If the question doesn't clearly map to one show (e.g. "what have we covered
  about AI regulation"), use `any`.
- Questions about a named person: pick the show they host or co-host on, or
  `any` if the person appears as a guest across shows.
- Date expressions: convert relative dates ("last week", "this month") into
  concrete `since`/`until` values using the supplied `today` date.
