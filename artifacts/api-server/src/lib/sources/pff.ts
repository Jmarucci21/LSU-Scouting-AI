import { logger } from "../logger";

const PFF_BASE = "https://api.profootballfocus.com";

export function pffConfigured(): boolean {
  return !!process.env.PFF_API_KEY;
}

let cachedJwt: { jwt: string; expiresAt: number } | null = null;

/**
 * PFF auth is two-step: exchange the API key at /auth/login for a short-lived
 * JWT (~1h), then call data endpoints with `Authorization: Bearer <jwt>`.
 */
async function getJwt(forceRefresh = false): Promise<string> {
  const key = process.env.PFF_API_KEY;
  if (!key) throw new Error("PFF_API_KEY not configured");
  if (!forceRefresh && cachedJwt && cachedJwt.expiresAt - Date.now() > 60_000) {
    return cachedJwt.jwt;
  }
  const res = await fetch(`${PFF_BASE}/auth/login`, {
    method: "POST",
    headers: { "x-api-key": key, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`PFF login failed (${res.status})`);
  }
  const body = (await res.json()) as { jwt?: string };
  if (!body.jwt) throw new Error("PFF login response had no jwt");
  // JWTs are ~1h; cache conservatively for 50 minutes.
  cachedJwt = { jwt: body.jwt, expiresAt: Date.now() + 50 * 60_000 };
  return body.jwt;
}

async function pffGet(path: string): Promise<Response> {
  let jwt = await getJwt();
  let res = await fetch(`${PFF_BASE}${path}`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
  });
  if (res.status === 401) {
    // Could be an expired token; re-mint once and retry before concluding the
    // feed itself is unentitled.
    jwt = await getJwt(true);
    res = await fetch(`${PFF_BASE}${path}`, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
    });
  }
  return res;
}

/**
 * Health check for the Data admin page. PFF auth (API key -> JWT) works for the
 * LSU account, but the NCAA data feeds are entitlement-gated by PFF and return
 * 401 until PFF grants access. Distinguish "auth works but feeds locked" from a
 * genuine credential failure so the operator knows who to contact.
 */
export async function checkPff(): Promise<{ ok: boolean; detail: string }> {
  if (!pffConfigured()) return { ok: false, detail: "PFF_API_KEY not set" };
  try {
    const jwt = await getJwt(true);
    if (!jwt) return { ok: false, detail: "PFF login returned no token" };
  } catch (e) {
    return {
      ok: false,
      detail: `Authentication failed: ${(e as Error).message}`,
    };
  }
  // Probe a representative NCAA data feed to determine real data access.
  try {
    const probe = await pffGet("/v1/grades/season/ncaa/2024/offense");
    if (probe.ok) {
      return { ok: true, detail: "Connected; NCAA grades feed accessible" };
    }
    if (probe.status === 401) {
      return {
        ok: false,
        detail:
          "Authenticated, but PFF has not granted this account access to NCAA data feeds. Contact PFF to enable NCAA API entitlements.",
      };
    }
    return {
      ok: false,
      detail: `Authenticated; NCAA feed probe returned ${probe.status}`,
    };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "PFF feed probe failed");
    return {
      ok: false,
      detail: `Authenticated; NCAA feed probe failed: ${(e as Error).message}`,
    };
  }
}
