/**
 * Host configuration.
 *
 * The cookie-direct image engine talks to TickTick's *internal* (unofficial)
 * v2 web API. The original implementation hardcoded the dida365.com (国内 /
 * Mainland China) endpoints, which is the only path that has actually been
 * verified to work.
 *
 * We expose `ticktick` (海外 / overseas, dida365's international sibling) as an
 * EXPERIMENTAL, UNVERIFIED option. The domains below are best-effort guesses;
 * cookie domains, CSRF behaviour and the attachment endpoints may differ. Treat
 * `--host ticktick --with-images` as "may simply not work".
 */

export type HostId = "dida365" | "ticktick";

export interface HostConfig {
  id: HostId;
  /** Whether the cookie-direct image path has been verified to work. */
  imagesVerified: boolean;
  /** Web origin, used for Referer + as a fallback fetch base. */
  webUrl: string;
  /** API origin, used as the primary fetch base. */
  apiUrl: string;
  /** Suffix matched against Chrome's cookie `host_key` column. */
  cookieHostSuffix: string;
  /** Default Accept-Language hint sent as the `Hl` header. */
  hl: string;
  /** Default timezone hint sent as the `X-Tz` header. */
  tz: string;
}

const HOSTS: Record<HostId, HostConfig> = {
  // 国内主路径，已验证。
  dida365: {
    id: "dida365",
    imagesVerified: true,
    webUrl: "https://dida365.com",
    apiUrl: "https://api.dida365.com",
    cookieHostSuffix: "dida365.com",
    hl: "zh_CN",
    tz: "Asia/Shanghai",
  },
  // 海外 / overseas — EXPERIMENTAL, endpoints unverified.
  ticktick: {
    id: "ticktick",
    imagesVerified: false,
    webUrl: "https://ticktick.com",
    apiUrl: "https://api.ticktick.com",
    cookieHostSuffix: "ticktick.com",
    hl: "en_US",
    tz: "America/Los_Angeles",
  },
};

export function resolveHost(id: string): HostConfig {
  if (id === "dida365" || id === "ticktick") {
    return HOSTS[id];
  }
  throw new Error(
    `Unknown --host "${id}". Expected "dida365" (国内, verified) or "ticktick" (海外, experimental).`,
  );
}
