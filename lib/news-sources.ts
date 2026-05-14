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
    'Associated Press + liveblog',
    'Reuters',
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
  'apnews.com',
  'ap.org',
  'reuters.com',
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

const approvedXHandles = new Set(
  newsSources.xAccounts.map((a) => a.handle.replace(/^@/, '').toLowerCase()),
);

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

  return approvedHostnames.some((allowed) =>
    host === allowed || host.endsWith(`.${allowed}`),
  );
}
