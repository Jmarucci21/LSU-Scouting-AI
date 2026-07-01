// College athletics-website headshot source. Layered BEHIND ESPN + Wikipedia,
// its purpose is the OLD seasons (2016/2017) where ESPN's roster coverage hits
// its ceiling: official team sites keep archived per-season rosters with real
// headshots far further back than ESPN's API exposes.
//
// There is no clean API mapping a school to its athletics domain, so TEAM_SITES
// is a hand-curated map keyed by our DB `team` name (FBS only — those are the
// schools we can actually match). A wrong/missing domain just fails the fetch
// for that school and is skipped (graceful: coverage gap, never a wrong face).
//
// Three site platforms dominate FBS, and we auto-detect + parse each from the
// server-rendered HTML (no JS execution needed — all three SSR the roster):
//   - Sidearm Sports ("s-person-*" cards): the majority of schools. URL
//     /sports/football/roster/{YYYY}. Name in the bio link's aria-label, photo
//     in a <source srcset> pointing at images.sidearmdev.com/crop?url=<encoded
//     original>; we decode the url param back to the full-res original.
//   - WMT/WordPress "rosters-directory" (e.g. LSU): URL
//     /sports/fb/roster/season/{YYYY}/. Name in .roster-list_item_info_name,
//     photo in a lazy data-bg="/imgproxy/..." (relative -> prepend domain).
//   - Vue "roster-card" (e.g. Clemson): URL /sports/football/roster/season/{YYYY}.
//     Name in .roster-card__title-link, photo the card image.
//
// Matching is school-scoped: the caller fetches one school's roster and matches
// only that school's players by normalized name, so a same-named player at
// another program can never be cross-stamped (precision-first).

const TEAM_SITE_TIMEOUT_MS = 25_000;
// Polite global ceiling across all schools (~8 req/s). We hit ~130 distinct
// hosts a few times each; the cap mostly protects our shared egress IP.
const TEAM_SITE_MIN_INTERVAL_MS = 120;
const TEAM_SITE_MAX_RETRIES = 3;
const TEAM_SITE_UA =
  "SCOUTPRO-LSU-Football/1.0 (Replit college-football scouting app; player headshot backfill)";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let nextSlot = 0;
async function rateGate(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + TEAM_SITE_MIN_INTERVAL_MS;
  const wait = start - now;
  if (wait > 0) await sleep(wait);
}

function backoffMs(attempt: number): number {
  return Math.min(12_000, 500 * 2 ** attempt) + Math.random() * 400;
}

// Fetch a URL as text, FOLLOWING redirects but reporting the final URL so the
// caller can reject a roster page that redirected to a generic landing/404 (some
// sites bounce an unknown season to a different sport entirely). Returns null on
// a non-OK status after retries.
async function getHtml(
  url: string,
): Promise<{ html: string; finalUrl: string } | null> {
  let attempt = 0;
  for (;;) {
    await rateGate();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TEAM_SITE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "User-Agent": TEAM_SITE_UA,
          accept: "text/html,application/xhtml+xml",
        },
      });
      if (
        (res.status === 429 || res.status >= 500) &&
        attempt < TEAM_SITE_MAX_RETRIES
      ) {
        attempt += 1;
        clearTimeout(timer);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (!res.ok) {
        clearTimeout(timer);
        return null;
      }
      const html = await res.text();
      return { html, finalUrl: res.url || url };
    } catch (e) {
      const retryable = attempt < TEAM_SITE_MAX_RETRIES;
      if (retryable) {
        attempt += 1;
        clearTimeout(timer);
        await sleep(backoffMs(attempt));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

export type TeamSiteRosterPlayer = { name: string; photoUrl: string };

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .trim();
}

// --- Platform parsers -----------------------------------------------------
// Each returns {name, photoUrl}[] (deduped by name). They are defensive: a card
// missing a name OR a photo is skipped (we only want pairs we can stamp).

function parseSidearm(html: string): TeamSiteRosterPlayer[] {
  const out: TeamSiteRosterPlayer[] = [];
  const seen = new Set<string>();
  // The bio link's aria-label carries the name; the player's <picture> source
  // (images.sidearmdev.com/crop?url=<encoded original>) follows within the card.
  const re =
    /aria-label="([^"]+?)(?: jersey number[^"]*?)? full bio"[\s\S]{0,1200}?images\.sidearmdev\.com\/crop\?url=([^&"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const name = decodeEntities(m[1]);
    let photoUrl = "";
    try {
      photoUrl = decodeURIComponent(m[2]);
    } catch {
      photoUrl = "";
    }
    if (!name || !photoUrl) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, photoUrl });
  }
  return out;
}

function parseWmt(html: string, domain: string): TeamSiteRosterPlayer[] {
  const out: TeamSiteRosterPlayer[] = [];
  const seen = new Set<string>();
  const cards = html.split('class="roster-list_item"').slice(1);
  for (const card of cards) {
    const chunk = card.slice(0, 2500);
    const nameM = chunk.match(/roster-list_item_info_name">([^<]+)/);
    const bgM = chunk.match(/data-bg="([^"]+)"/);
    if (!nameM || !bgM) continue;
    const name = decodeEntities(nameM[1]);
    const raw = bgM[1];
    const photoUrl = raw.startsWith("http") ? raw : `https://${domain}${raw}`;
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, photoUrl });
  }
  return out;
}

function parseVue(html: string): TeamSiteRosterPlayer[] {
  const out: TeamSiteRosterPlayer[] = [];
  const seen = new Set<string>();
  // Cards begin at the image wrapper; the title-link (name) follows in the body.
  const cards = html.split('class="roster-card__image-wrapper"').slice(1);
  for (const card of cards) {
    const chunk = card.slice(0, 3000);
    const nameM = chunk.match(/roster-card__title-link[^>]*>\s*([^<]+)/);
    if (!nameM) continue;
    const name = decodeEntities(nameM[1]);
    if (!name) continue;
    // Photo: prefer a Sidearm-style encoded original, else any plausible image
    // src/data-src in the card's image region.
    let photoUrl = "";
    const cropM = chunk.match(/images\.sidearmdev\.com\/crop\?url=([^&"]+)/);
    if (cropM) {
      try {
        photoUrl = decodeURIComponent(cropM[1]);
      } catch {
        photoUrl = "";
      }
    }
    if (!photoUrl) {
      const imgM = chunk.match(
        /(?:data-src|src)="(https?:\/\/[^"]+\.(?:jpe?g|png|webp)[^"]*)"/i,
      );
      if (imgM) photoUrl = imgM[1];
    }
    if (!photoUrl) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, photoUrl });
  }
  return out;
}

function parseRoster(html: string, domain: string): TeamSiteRosterPlayer[] {
  // Try every parser and keep whichever yields the most players — platform
  // detection by sheer markup presence can be fooled by shared chrome, so the
  // richest result wins.
  const candidates = [
    parseSidearm(html),
    parseWmt(html, domain),
    parseVue(html),
  ];
  return candidates.reduce((best, cur) =>
    cur.length > best.length ? cur : best,
  );
}

// Map our DB `team` (school) name -> athletics-site domain. FBS only. Curated;
// unknown schools are simply not fetched.
export const TEAM_SITES: Record<string, string> = {
  "Air Force": "goairforcefalcons.com",
  Akron: "gozips.com",
  Alabama: "rolltide.com",
  "App State": "appstatesports.com",
  "Appalachian State": "appstatesports.com",
  Arizona: "arizonawildcats.com",
  "Arizona State": "thesundevils.com",
  Arkansas: "arkansasrazorbacks.com",
  "Arkansas State": "astateredwolves.com",
  Army: "goarmywestpoint.com",
  Auburn: "auburntigers.com",
  BYU: "byucougars.com",
  "Brigham Young": "byucougars.com",
  "Ball State": "ballstatesports.com",
  Baylor: "baylorbears.com",
  "Boise State": "broncosports.com",
  "Boston College": "bceagles.com",
  "Bowling Green": "bgsufalcons.com",
  Buffalo: "ubbulls.com",
  California: "calbears.com",
  "Central Michigan": "cmuchippewas.com",
  Charlotte: "charlotte49ers.com",
  Cincinnati: "gobearcats.com",
  Clemson: "clemsontigers.com",
  "Coastal Carolina": "goccusports.com",
  Colorado: "cubuffs.com",
  "Colorado State": "csurams.com",
  Connecticut: "uconnhuskies.com",
  UConn: "uconnhuskies.com",
  Delaware: "bluehens.com",
  "Delaware Fightin Blue Hens": "bluehens.com",
  Duke: "goduke.com",
  "East Carolina": "ecupirates.com",
  "Eastern Michigan": "emueagles.com",
  Florida: "floridagators.com",
  "Florida Atlantic": "fausports.com",
  "Florida International": "fiusports.com",
  "Florida State": "seminoles.com",
  "Fresno State": "gobulldogs.com",
  Georgia: "georgiadogs.com",
  "Georgia Southern": "gseagles.com",
  "Georgia State": "georgiastatesports.com",
  "Georgia Tech": "ramblinwreck.com",
  Hawaii: "hawaiiathletics.com",
  "Hawai'i": "hawaiiathletics.com",
  Houston: "uhcougars.com",
  Illinois: "fightingillini.com",
  Indiana: "iuhoosiers.com",
  Iowa: "hawkeyesports.com",
  "Iowa State": "cyclones.com",
  "Jacksonville State": "jaxstatesports.com",
  "Jacksonville State Gamecocks": "jaxstatesports.com",
  "James Madison": "jmusports.com",
  "James Madison Dukes": "jmusports.com",
  Kansas: "kuathletics.com",
  "Kansas State": "kstatesports.com",
  "Kennesaw State": "ksuowls.com",
  "Kennesaw State Owls": "ksuowls.com",
  "Kent State": "kentstatesports.com",
  Kentucky: "ukathletics.com",
  LSU: "lsusports.net",
  Liberty: "libertyflames.com",
  Louisiana: "ragincajuns.com",
  "Louisiana-Lafayette": "ragincajuns.com",
  "Louisiana Tech": "latechsports.com",
  "Louisiana-Monroe": "ulmwarhawks.com",
  "UL Monroe": "ulmwarhawks.com",
  Louisville: "gocards.com",
  Marshall: "herdzone.com",
  Maryland: "umterps.com",
  Massachusetts: "umassathletics.com",
  Memphis: "gotigersgo.com",
  "Miami (FL)": "hurricanesports.com",
  "Miami (OH)": "miamiredhawks.com",
  Michigan: "mgoblue.com",
  "Michigan State": "msuspartans.com",
  "Middle Tennessee": "goblueraiders.com",
  Minnesota: "gophersports.com",
  "Mississippi State": "hailstate.com",
  Missouri: "mutigers.com",
  "Missouri State": "missouristatebears.com",
  "Missouri State Bears": "missouristatebears.com",
  Navy: "navysports.com",
  Nebraska: "huskers.com",
  Nevada: "nevadawolfpack.com",
  "New Mexico": "golobos.com",
  "New Mexico State": "nmstatesports.com",
  "North Carolina": "goheels.com",
  "North Carolina State": "gopack.com",
  "NC State": "gopack.com",
  "North Texas": "meangreensports.com",
  "Northern Illinois": "niuhuskies.com",
  Northwestern: "nusports.com",
  "Notre Dame": "und.com",
  Ohio: "ohiobobcats.com",
  "Ohio State": "ohiostatebuckeyes.com",
  Oklahoma: "soonersports.com",
  "Oklahoma State": "okstate.com",
  "Old Dominion": "odusports.com",
  "Ole Miss": "olemisssports.com",
  Oregon: "goducks.com",
  "Oregon State": "osubeavers.com",
  "Penn State": "gopsusports.com",
  Pittsburgh: "pittsburghpanthers.com",
  Purdue: "purduesports.com",
  Rice: "riceowls.com",
  Rutgers: "scarletknights.com",
  SMU: "smumustangs.com",
  "Southern Methodist": "smumustangs.com",
  "Sam Houston": "gobearkats.com",
  "Sam Houston State Bearkats": "gobearkats.com",
  "San Diego State": "goaztecs.com",
  "San Jose State": "sjsuspartans.com",
  "San José State": "sjsuspartans.com",
  "South Alabama": "usajaguars.com",
  "South Carolina": "gamecocksonline.com",
  "South Florida": "gousfbulls.com",
  "Southern Miss": "southernmiss.com",
  Stanford: "gostanford.com",
  Syracuse: "cuse.com",
  TCU: "gofrogs.com",
  Temple: "owlsports.com",
  Tennessee: "utsports.com",
  Texas: "texassports.com",
  "Texas A&M": "12thman.com",
  "Texas State": "txstatebobcats.com",
  "Texas Tech": "texastech.com",
  Toledo: "utrockets.com",
  Troy: "troytrojans.com",
  Tulane: "tulanegreenwave.com",
  Tulsa: "tulsahurricane.com",
  UAB: "uabsports.com",
  UCF: "ucfknights.com",
  UCLA: "uclabruins.com",
  UNLV: "unlvrebels.com",
  USC: "usctrojans.com",
  UTEP: "utepminers.com",
  UTSA: "goutsa.com",
  Utah: "utahutes.com",
  "Utah State": "utahstateaggies.com",
  Vanderbilt: "vucommodores.com",
  Virginia: "virginiasports.com",
  "Virginia Tech": "hokiesports.com",
  "Wake Forest": "godeacs.com",
  Washington: "gohuskies.com",
  "Washington State": "wsucougars.com",
  "West Virginia": "wvusports.com",
  "Western Kentucky": "wkusports.com",
  "Western Michigan": "wmubroncos.com",
  Wisconsin: "uwbadgers.com",
  Wyoming: "gowyo.com",
};

// Candidate roster-URL patterns covering the three platforms' season formats.
// We try them in order and keep the first that parses to a non-trivial roster.
function candidateUrls(domain: string, season: number): string[] {
  return [
    `https://${domain}/sports/football/roster/${season}`,
    `https://${domain}/sports/football/roster/season/${season}`,
    `https://${domain}/sports/fb/roster/season/${season}/`,
    `https://${domain}/sports/football/roster/season/${season}-${String(
      (season + 1) % 100,
    ).padStart(2, "0")}`,
  ];
}

/**
 * Fetch and parse one school's archived football roster for a season. Tries the
 * known URL patterns until one yields a roster of real players, then returns
 * {name, photoUrl} pairs. Returns [] if no pattern produced a usable roster (a
 * dead/changed domain, an anti-scrape redirect, or a season the site no longer
 * keeps online) — the caller treats that as a skipped school.
 */
export async function fetchTeamSiteRoster(
  domain: string,
  season: number,
): Promise<TeamSiteRosterPlayer[]> {
  for (const url of candidateUrls(domain, season)) {
    let page: { html: string; finalUrl: string } | null = null;
    try {
      page = await getHtml(url);
    } catch {
      continue;
    }
    if (!page) continue;
    // Reject a redirect that bounced us off the football roster entirely
    // (e.g. to another sport or a generic landing page).
    if (!/\/(?:football|fb)\//.test(page.finalUrl)) continue;
    const players = parseRoster(page.html, domain);
    // A real FBS roster is dozens of players; a couple of stray matches usually
    // means we parsed chrome, not the roster — keep looking.
    if (players.length >= 10) return players;
  }
  return [];
}
