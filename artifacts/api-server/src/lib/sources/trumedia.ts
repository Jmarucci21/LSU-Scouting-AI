import { logger } from "../logger";

const TM_BASE = "https://api.trumedianetworks.com";

let cachedToken: { token: string; expiresAt: number } | null = null;

export function trumediaConfigured(): boolean {
  return !!(
    process.env.TRUMEDIA_MASTER_TOKEN &&
    process.env.TRUMEDIA_USERNAME &&
    process.env.TRUMEDIA_SITENAME
  );
}

export async function getTempToken(): Promise<string> {
  const token = process.env.TRUMEDIA_MASTER_TOKEN;
  const username = process.env.TRUMEDIA_USERNAME;
  const sitename = process.env.TRUMEDIA_SITENAME;
  if (!token || !username || !sitename) {
    throw new Error("TruMedia is not fully configured");
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const res = await fetch(
    `${TM_BASE}/v1/siteadmin/api/createTempPBToken`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, sitename, token }),
    },
  );
  if (!res.ok) {
    throw new Error(`TruMedia token exchange responded ${res.status}`);
  }
  const json = (await res.json()) as { pbTempToken?: string; success?: number };
  if (!json.pbTempToken) {
    throw new Error("TruMedia token exchange returned no token");
  }
  // Temp tokens last 24h by default; cache conservatively for 12h.
  cachedToken = {
    token: json.pbTempToken,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  };
  logger.info("Obtained TruMedia temp token");
  return json.pbTempToken;
}

export async function checkTrumedia(): Promise<{ ok: boolean; detail: string }> {
  if (!trumediaConfigured()) {
    return {
      ok: false,
      detail:
        "TRUMEDIA_MASTER_TOKEN, TRUMEDIA_USERNAME, or TRUMEDIA_SITENAME not set",
    };
  }
  try {
    await getTempToken();
    return { ok: true, detail: "Token exchange OK" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
