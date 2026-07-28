export const newsSources = {
  xAccounts: [
    { handle: '@AmitSegal', name: 'Amit Segal', role: 'Channel 12 political analyst, Ark Media contributor' },
    { handle: '@Nadav_Eyal', name: 'Nadav Eyal', role: 'Yediot Ahronot columnist, Ark Media contributor' },
    { handle: '@BarakRavid', name: 'Barak Ravid', role: 'Axios and Walla reporter' },
    { handle: '@havivrettiggur', name: 'Haviv Rettig Gur', role: 'Free Press analyst' },
    { handle: '@JoshKraushaar', name: 'Josh Kraushaar', role: 'Jewish Insider editor in chief' },
    { handle: '@benshapiro', name: 'Ben Shapiro', role: 'Daily Wire founder' },
    { handle: '@lahavharkov', name: 'Lahav Harkov', role: 'Jewish Insider Israel reporter' },
    { handle: '@shemeshmicha', name: 'Michael Shemesh', role: 'Kan political correspondent' },
    { handle: '@ranboker', name: 'Ran Boker', role: 'Ynet reporter' },
    { handle: '@BaruchYedid', name: 'Baruch Yedid', role: 'Channel 14 Arab affairs reporter' },
    { handle: '@AmichaiStein1', name: 'Amichai Stein', role: 'Kan diplomatic correspondent' },
    { handle: '@AnnaBarskiy', name: 'Anna Rayva-Barsky', role: 'Maariv political correspondent' },
    { handle: '@Doron_Kadosh', name: 'Doron Kadosh', role: 'Army Radio military correspondent' },
    { handle: '@inon_yttach', name: 'Yinon Shalom Yatach', role: 'i24 News military correspondent' },
    { handle: '@Osint613', name: 'Open Source Intel', role: '' },
  ],
  englishSites: [
    'Times of Israel + liveblog (most useful for developing stories)',
    'Wall Street Journal + liveblog',
    'New York Times',
    'Washington Post',
    'Associated Press + liveblog',
    'Reuters',
    'The Guardian',
    'Financial Times',
    'BBC',
    'Jerusalem Post + liveblog',
    'I24 News English',
    'Haaretz English + liveblog',
    'Al Jazeera English',
    'It\'s Noon in Israel – Amit Segal',
    'Between Us – Nadav Eyal',
    'Semafor',
    'Bloomberg',
  ],
  hebrewSites: [
    'Ynet + liveblog',
    'Israel Hayom + liveblog',
    'Kan + liveblog',
    'Maariv + liveblog',
    'Channel 14 + liveblog',
    'Calcalist + liveblog',
    'Walla + liveblog',
    'Haaretz',
    'Channel 12/Mako',
    'Globes',
    'Channel 13',
  ],
  analysisAndThinkTanks: [
    'Foundation for Defense of Democracies',
    'Free Press',
    'Jerusalem Institute for Strategy and Security',
    'Institute for National Security Studies',
    'Jewish Institute for National Security of America',
    'Misgav Institute',
    'Alma Center',
    'Tablet',
    'Commentary',
    'Atlantic',
    'Foreign Affairs',
  ],
};

// Hostnames mapped to outlets above. Suffix-matched, so subdomains
// (news.walla.co.il, www.haaretz.com) are covered automatically. Exported
// for the orchestrator's keyword search, which scopes Tavily queries to
// `include_domains: approvedHostnames`.
export const approvedHostnames = [
  'timesofisrael.com',
  'wsj.com',
  'nytimes.com',
  'washingtonpost.com',
  'apnews.com',
  'ap.org',
  'reuters.com',
  'reut.rs',
  'theguardian.com',
  'ft.com',
  'bbc.com',
  'bbc.co.uk',
  'jpost.com',
  'i24news.tv',
  'haaretz.com',
  'haaretz.co.il',
  'aljazeera.com',
  'aljazeera.net',
  'semafor.com',
  'bloomberg.com',
  'ynet.co.il',
  'ynetnews.com',
  'israelhayom.co.il',
  'israelhayom.com',
  'kan.org.il',
  'maariv.co.il',
  'now14.co.il',
  'channel14.co.il',
  'calcalist.co.il',
  'walla.co.il',
  'mako.co.il',
  'n12.co.il',
  'globes.co.il',
  '13tv.co.il',
  'reshet13.co.il',
  'fdd.org',
  'thefp.com',
  'jiss.org.il',
  'inss.org.il',
  'jinsa.org',
  'misgavins.org',
  'israel-alma.org',
  'tabletmag.com',
  'commentary.org',
  'theatlantic.com',
  'foreignaffairs.com',
];

// Hard-paywall outlets. Tavily Extract returns only the headline + a teaser for
// these — not the body — so a writer can't satisfy the "cite or don't answer"
// rule from them. They stay in discovery for lead-spotting, but the
// orchestrator swaps each one for a free-outlet mirror of the same story before
// the writer triages (see substitutePaywallMirrors). All four are hard
// metered/subscriber paywalls.
export const hardPaywallHostnames = [
  'wsj.com',
  'nytimes.com',
  'washingtonpost.com',
  'ft.com',
];

// The show's beat — Israel, Jews, and the Middle East — as durable thematic
// queries. Deliberately broad and evergreen: the freshness window and the
// downstream scoring do the narrowing. No event-specific terms ("hostages",
// "Gaza war") — those go stale and would need constant re-tuning. Query *count*
// per theme doubles as the weighting knob, since both pipelines merge these
// round-robin: the three Israel queries hand the show's core beat ~1/3 of the
// triaged pool. Tune the set here if coverage gaps show up. X/Twitter is
// intentionally absent — it comes in through `discoverXPosts`.
//
// Shared by both discovery pipelines, which differ on outlet policy but not on
// the beat: `orchestrator/source-gathering.discoverCandidates` scopes these to
// `include_domains: approvedHostnames`, while `scriptwriter/sourcing`
// `discoverOpenWeb` runs them against the open web and judges credibility
// per source. The queries themselves are editorial, not policy — keep them in
// one place so the beat can't drift between the two.
export const DISCOVERY_QUERIES = [
  'Israel',
  'Israeli politics',
  'Israeli security',
  'Iran',
  'Middle East geopolitics',
  'Israel international relations',
  'antisemitism',
  'Jewish diaspora life',
  'Jewish identity',
];

const approvedXHandles = new Set(
  newsSources.xAccounts.map((a) => a.handle.replace(/^@/, '').toLowerCase()),
);

// Suffix-match a URL's hostname against a list of bare domains, so subdomains
// (www.bbc.com, news.walla.co.il) match their root. Returns false on unparseable
// URLs. Shared by the source-tier predicates below.
function hostInList(url: string, domains: string[]): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return domains.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

// True when the URL is a hard-paywall outlet whose body Tavily can't extract.
export function isHardPaywallSource(url: string): boolean {
  return hostInList(url, hardPaywallHostnames);
}

export function isApprovedSource(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase();

  // X/Twitter: only approve canonical tweet URLs of the form
  // /{handle}/status/{id} from listed handles. This rejects route-style
  // paths (`x.com/i/...`, `x.com/intent/...`, `x.com/search/...`) where the
  // first segment isn't a real handle, and rejects bare profile URLs that
  // don't carry a citable post.
  const isTwitterHost =
    host === 'twitter.com' || host === 'x.com' ||
    host.endsWith('.twitter.com') || host.endsWith('.x.com');
  if (isTwitterHost) {
    const segs = parsed.pathname.split('/').filter(Boolean);
    if (segs.length < 3 || segs[1].toLowerCase() !== 'status') return false;
    const handle = segs[0].toLowerCase();
    return approvedXHandles.has(handle);
  }

  return hostInList(url, approvedHostnames);
}
