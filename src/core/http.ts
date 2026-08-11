/**
 * The only place Radar talks to the network.
 *
 * Radar reads eight public APIs, several of them run by public institutions
 * and none of them owed anything by this project. The rules here are about
 * being a guest:
 *
 *   1. IDENTIFY. Descriptive User-Agent with a contact URL. Anonymous
 *      high-volume scraping of NCBI or a university calendar is how an IP
 *      gets blocked, and the block lands on a shared runner.
 *   2. THROTTLE PER HOST, NOT GLOBALLY. NCBI documents a hard 3 requests/second
 *      per IP without an API key (10/s with one) and will return 429 above it.
 *      A global limiter would either be too slow for everyone else or too fast
 *      for NCBI, so the interval is per-hostname.
 *   3. BOUND EVERYTHING. Hard per-request timeout, capped retries with
 *      exponential backoff and jitter, and a ceiling on pages walked.
 *   4. NEVER THROW ACROSS THE BOUNDARY. `getJson`/`getText` throw; every
 *      connector catches and degrades. A dead upstream must produce a warning
 *      and a partial build, never a failed deploy.
 *
 * Nothing in here runs in the browser - see the CORS note in astro.config.mjs.
 */

import type { Logger } from '@/types.ts';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const USER_AGENT =
  'radar/1.0 (+https://harsh.bet/radar; personal research + campus discovery aggregator; static site, one pass per build)';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 600;

/**
 * Minimum gap between requests to the same host, in milliseconds.
 *
 * NCBI's published ceiling is 3/s unkeyed; 350ms leaves headroom for clock
 * skew rather than riding the limit exactly. The rest are courtesy values -
 * none of these APIs publish a hard limit for this volume, and Radar makes
 * tens of requests per run, not thousands.
 */
const HOST_MIN_INTERVAL_MS: Record<string, number> = {
  // 400ms, not 350. A first run at 350 still drew 429s from NCBI: the limit is
  // enforced strictly and the esearch->efetch pair arrives back-to-back. The
  // retry path recovers, but drawing 429s at all is being a bad guest.
  'eutils.ncbi.nlm.nih.gov': 400,
  'api.biorxiv.org': 250,
  'api.crossref.org': 200,
  'api.openalex.org': 150,
  'export.arxiv.org': 3_000, // arXiv's own manual asks for one request per 3s.
  'www.ebi.ac.uk': 200,
  'calendar.tamu.edu': 200,
  'research.tamu.edu': 250,
};

const DEFAULT_MIN_INTERVAL_MS = 250;

export const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// Per-host throttle
// ---------------------------------------------------------------------------

/**
 * Next timestamp at which each host may be called.
 *
 * Module-level and therefore shared by every connector in a run, which is the
 * point: PubMed and (a future) other NCBI reader must share one budget,
 * because NCBI counts per IP, not per code path.
 */
const nextAllowedAt = new Map<string, number>();

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Block until this host's cooldown has elapsed, then claim the next slot. */
async function acquireHostSlot(url: string): Promise<void> {
  const host = hostOf(url);
  const interval = HOST_MIN_INTERVAL_MS[host] ?? DEFAULT_MIN_INTERVAL_MS;
  const now = Date.now();
  const readyAt = nextAllowedAt.get(host) ?? 0;

  if (readyAt > now) await sleep(readyAt - now);
  nextAllowedAt.set(host, Math.max(now, readyAt) + interval);
}

/** Test seam: forget all throttle state so a suite does not wait on real clocks. */
export function resetThrottle(): void {
  nextAllowedAt.clear();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** 5xx and the "slow down" family are worth retrying; other 4xx are not. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

interface FatalMarker {
  fatal?: boolean;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface RequestOptions {
  timeoutMs?: number;
  /** Total attempts including the first. Minimum 1. */
  attempts?: number;
  baseDelayMs?: number;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  log?: Logger;
  /** Extra request headers, e.g. an Accept override for Atom. */
  headers?: Record<string, string>;
}

interface ResolvedOptions {
  timeoutMs: number;
  attempts: number;
  baseDelayMs: number;
  fetchImpl: typeof fetch;
  log: Logger;
  headers: Record<string, string>;
}

export function resolveOptions(options: RequestOptions = {}): ResolvedOptions {
  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    attempts: Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS),
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    log: options.log ?? consoleLogger,
    headers: options.headers ?? {},
  };
}

/**
 * GET with throttling, a hard timeout, and bounded exponential backoff.
 *
 * Throws once every attempt is exhausted. Connectors are expected to catch.
 */
async function request(url: string, accept: string, options: ResolvedOptions): Promise<Response> {
  const { timeoutMs, attempts, baseDelayMs, fetchImpl, log, headers } = options;
  let lastError: unknown = new Error('no attempts made');

  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await acquireHostSlot(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);

    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          accept,
          'accept-encoding': 'gzip, deflate',
          'user-agent': USER_AGENT,
          ...headers,
        },
      });

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        if (!isRetryableStatus(res.status)) throw Object.assign(err, { fatal: true });

        // Honour Retry-After when the server sends one; it knows better than
        // our backoff curve does. Capped so a hostile value cannot stall a build.
        const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          const wait = Math.min(retryAfter, 30) * 1000;
          log.warn(`[http] ${res.status} from ${hostOf(url)}; honouring Retry-After ${wait}ms`);
          await sleep(wait);
        }
        throw err;
      }

      return res;
    } catch (err) {
      lastError = err;
      const fatal = typeof err === 'object' && err !== null && (err as FatalMarker).fatal === true;
      if (fatal || attempt === attempts) break;

      // Jitter so parallel connectors hitting the same host do not resynchronize.
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 150);
      log.warn(`[http] attempt ${attempt}/${attempts} failed (${describeError(err)}); retrying in ${delay}ms`);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(describeError(lastError));
}

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
}

export async function getJson<T>(url: string, options: RequestOptions = {}): Promise<JsonResponse<T>> {
  const resolved = resolveOptions(options);
  const res = await request(url, 'application/json', resolved);
  return { data: (await res.json()) as T, headers: res.headers };
}

export async function getText(url: string, options: RequestOptions = {}): Promise<string> {
  const resolved = resolveOptions(options);
  const accept = resolved.headers['accept'] ?? 'application/atom+xml, application/xml, text/xml, */*';
  const res = await request(url, accept, resolved);
  return res.text();
}

// ---------------------------------------------------------------------------
// Politeness credentials
// ---------------------------------------------------------------------------

/**
 * Contact address for Crossref's and OpenAlex's polite pools.
 *
 * Read from the environment at ingest time and never persisted. It must not
 * reach `src/data/` or `dist/` - the CI email guard fails the build if any
 * address appears in the published output, and that guard is the reason this
 * is a function rather than an inlined constant.
 */
export function contactEmail(): string | null {
  const value = process.env['RADAR_CONTACT_EMAIL']?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

/** NCBI API key, when configured. Raises E-utilities from 3/s to 10/s. */
export function ncbiApiKey(): string | null {
  const value = process.env['NCBI_API_KEY']?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

/** Append params, skipping null/undefined, and return the built URL. */
export function buildUrl(base: string, params: Record<string, string | number | null | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
