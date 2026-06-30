// Wikipedia headshot fallback. Unlike ESPN (which we iterate roster-first),
// Wikipedia has no roster structure, so the caller looks players up by name.
//
// We use the MediaWiki Action API (w/api.php), NOT the REST page/summary
// endpoint: the REST endpoint hard-throttles our shared egress IP (429 on
// nearly every request), whereas the Action API both behaves under load AND
// lets us BATCH many titles per request. Batching is essential — looking up
// ~10k players one-at-a-time would self-DOS the shared IP into 429s; batching
// collapses that to a few hundred requests the throttle tolerates easily.
//
// The article's lead-image thumbnail is returned alongside the short
// description + intro extract, which the caller uses to confirm the page is
// about the right football player (precision over recall: a wrong face is worse
// than a missing one). Wikipedia/Wikimedia images are openly licensed.
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_TIMEOUT_MS = 20_000;
// ~16 req/s ceiling. We issue only a few hundred (batched) requests total, so
// this is plenty fast while staying polite to Wikimedia's shared infra (their
// UA policy asks clients to identify themselves and not hammer the API).
const WIKI_MIN_INTERVAL_MS = 60;
const WIKI_MAX_RETRIES = 4;
// The Action API's TextExtracts prop caps at 20 titles per request, so that's
// our batch size (we need the intro extract to verify the player's school).
export const WIKI_BATCH_SIZE = 20;
const WIKI_UA =
  "SCOUTPRO-LSU-Football/1.0 (Replit college-football scouting app; player headshot backfill)";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let nextSlot = 0;
async function rateGate(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + WIKI_MIN_INTERVAL_MS;
  const wait = start - now;
  if (wait > 0) await sleep(wait);
}

function backoffMs(attempt: number): number {
  return Math.min(15_000, 500 * 2 ** attempt) + Math.random() * 400;
}

async function getJson(url: string): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    await rateGate();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": WIKI_UA, accept: "application/json" },
      });
      // 429 = throttling (the API returns a non-JSON body), 5xx = transient.
      if (
        (res.status === 429 || res.status >= 500) &&
        attempt < WIKI_MAX_RETRIES
      ) {
        attempt += 1;
        clearTimeout(timer);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (!res.ok)
        throw new Error(`Wikipedia responded ${res.status} for ${url}`);
      return (await res.json()) as unknown;
    } catch (e) {
      const retryable =
        e instanceof Error &&
        !e.message.startsWith("Wikipedia responded") &&
        attempt < WIKI_MAX_RETRIES;
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

export type WikiPage = {
  imageUrl: string | null;
  // Lowercased so the caller can cheaply substring-check sport + school.
  descLower: string;
  extractLower: string;
};

type ActionPage = {
  title?: string;
  missing?: string;
  description?: string;
  extract?: string;
  thumbnail?: { source?: string };
  pageprops?: { disambiguation?: string };
};

type ActionResponse = {
  query?: {
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
    pages?: Record<string, ActionPage>;
  };
};

/**
 * Resolve a batch of article titles in a single Action API request, returning a
 * map keyed by the EXACT input title. The API normalizes/redirects titles
 * internally and reports the hops; we replay those hops to map each result back
 * to what we asked for. A title with no article (or a disambiguation page) maps
 * to null. Up to WIKI_BATCH_SIZE titles per call (TextExtracts limit).
 */
export async function fetchWikiBatch(
  titles: string[],
): Promise<Map<string, WikiPage | null>> {
  const out = new Map<string, WikiPage | null>();
  for (const t of titles) out.set(t, null);
  if (titles.length === 0) return out;

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    redirects: "1",
    prop: "pageimages|description|extracts|pageprops",
    ppprop: "disambiguation",
    exintro: "1",
    explaintext: "1",
    exlimit: "max",
    piprop: "thumbnail",
    pithumbsize: "320",
    titles: titles.join("|"),
  });
  const j = (await getJson(`${WIKI_API}?${params.toString()}`)) as ActionResponse;
  const q = j?.query;
  if (!q) return out;

  const normMap = new Map<string, string>();
  for (const n of q.normalized ?? []) normMap.set(n.from, n.to);
  const redirMap = new Map<string, string>();
  for (const r of q.redirects ?? []) redirMap.set(r.from, r.to);

  const byTitle = new Map<string, WikiPage | null>();
  for (const key of Object.keys(q.pages ?? {})) {
    const p = (q.pages as Record<string, ActionPage>)[key];
    if (!p?.title) continue;
    if (p.missing !== undefined || p.pageprops?.disambiguation !== undefined) {
      byTitle.set(p.title, null);
      continue;
    }
    byTitle.set(p.title, {
      imageUrl: p.thumbnail?.source ?? null,
      descLower: (p.description ?? "").toLowerCase(),
      extractLower: (p.extract ?? "").toLowerCase(),
    });
  }

  // Replay normalization + redirect hops to find the final article title for an
  // input title (either may chain, and they can interleave).
  function resolve(title: string): string {
    let cur = title;
    for (let i = 0; i < 8; i += 1) {
      const n = normMap.get(cur);
      if (n && n !== cur) {
        cur = n;
        continue;
      }
      const r = redirMap.get(cur);
      if (r && r !== cur) {
        cur = r;
        continue;
      }
      break;
    }
    return cur;
  }

  for (const t of titles) out.set(t, byTitle.get(resolve(t)) ?? null);
  return out;
}
