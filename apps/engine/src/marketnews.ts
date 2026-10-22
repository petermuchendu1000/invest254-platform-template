/**
 * Market news for the terminal's News tab.
 *
 * MetaTrader's News tab carries the broker's newswire. There is a real one behind this: the engine
 * polls public RSS feeds, parses and caches them, and serves the result over the same socket the
 * chart already uses. It is deliberately server-side — a browser cannot read these feeds (no CORS
 * headers), and routing it through the engine means one fetch serves every connected player instead
 * of one per tab.
 *
 * Everything here is UNTRUSTED third-party text. Titles and summaries are stripped of markup and
 * length-capped before they leave this module, and the client renders them as text, never as HTML.
 *
 * It must never be able to break the socket: a feed that is slow, blocked by the environment's
 * network policy, or returning nonsense degrades to "whatever we last had", or to an empty list.
 */

export interface NewsItem {
  /** Stable id (the item's link), so a client can de-duplicate across refreshes. */
  id: string;
  title: string;
  /** Feed the item came from, shown as MetaTrader shows the news source. */
  source: string;
  url: string;
  publishedAtMs: number;
  /** Plain-text lead, markup stripped. Empty when the feed gives none. */
  summary: string;
}

export interface NewsFeed {
  /** Label shown in the Source column. */
  source: string;
  url: string;
}

/**
 * Public feeds, chosen for an XAUUSD terminal: currencies, commodities, and the market overview.
 * Reachability is environment-dependent — a blocked feed is skipped, not fatal.
 */
export const DEFAULT_FEEDS: NewsFeed[] = [
  { source: "Forex", url: "https://www.investing.com/rss/news_1.rss" },
  { source: "Commodities", url: "https://www.investing.com/rss/commodities.rss" },
  { source: "Markets", url: "https://www.investing.com/rss/news_285.rss" },
  { source: "Economy", url: "https://www.investing.com/rss/news_11.rss" },
];

const TITLE_MAX = 300;
const SUMMARY_MAX = 400;

/** Decode the entities an RSS feed actually uses. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // `&amp;` LAST, so "&amp;lt;" decodes to the literal text "&lt;" rather than to "<".
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try { return String.fromCodePoint(n); } catch { return ""; }
}

/**
 * Strip markup and collapse whitespace. Feed summaries routinely contain it.
 *
 * Decoding happens BEFORE stripping, and the order matters. Feeds commonly escape their markup
 * (`&lt;b&gt;`); stripping first would find no tags, and decoding afterwards would hand the caller
 * live markup that had already passed the filter. Stripping repeats until it is a no-op, so a tag
 * exposed by removing an outer one cannot survive either.
 */
export function toPlainText(s: string, max: number): string {
  let text = decodeEntities(s);
  for (let i = 0; i < 4; i++) {
    const next = text.replace(/<[^>]*>/g, " ");
    if (next === text) break;
    text = next;
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const tagOf = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!m) return null;
  const raw = m[1] ?? "";
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw);
  return cdata ? cdata[1] ?? "" : raw;
};

/**
 * Parse an RSS 2.0 (or Atom-ish) document into items.
 *
 * Written by hand rather than with an XML dependency: the shape needed here is four fields per
 * item, and a tolerant reader is better than a strict one against feeds that are frequently
 * slightly malformed. Anything it cannot read is skipped rather than throwing.
 */
export function parseFeed(xml: string, source: string, nowMs = Date.now()): NewsItem[] {
  const out: NewsItem[] = [];
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const title = toPlainText(tagOf(block, "title") ?? "", TITLE_MAX);
    if (!title) continue;
    // Atom puts the target in href; RSS in the element body.
    const linkEl = tagOf(block, "link") ?? "";
    const href = /<link[^>]*href=["']([^"']+)["']/i.exec(block)?.[1] ?? "";
    const url = (decodeEntities(linkEl).trim() || decodeEntities(href).trim());
    if (!/^https?:\/\//i.test(url)) continue; // no link, or a scheme we will not hand a browser
    const dateRaw = tagOf(block, "pubDate") ?? tagOf(block, "published") ?? tagOf(block, "updated") ?? "";
    const parsed = Date.parse(decodeEntities(dateRaw).trim());
    out.push({
      id: url,
      title,
      source,
      url,
      // An unreadable or absent date sorts as "now" rather than 1970, which would bury the item.
      publishedAtMs: Number.isFinite(parsed) ? parsed : nowMs,
      summary: toPlainText(tagOf(block, "description") ?? tagOf(block, "summary") ?? "", SUMMARY_MAX),
    });
  }
  return out;
}

export interface MarketNewsOptions {
  feeds?: NewsFeed[];
  /** How long a fetched set stays fresh. MetaTrader's newswire is not a tick stream. */
  ttlMs?: number;
  /** Hard cap on items held. */
  max?: number;
  /** Per-feed request timeout. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onError?: (err: Error, ctx: string) => void;
}

export class MarketNews {
  private items: NewsItem[] = [];
  private fetchedAtMs = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly opts: MarketNewsOptions = {}) {}

  private get now(): number { return (this.opts.now ?? Date.now)(); }

  /** True once the cache is older than its TTL (or was never filled). */
  private stale(): boolean {
    return this.now - this.fetchedAtMs >= (this.opts.ttlMs ?? 5 * 60_000);
  }

  /**
   * Cached items, newest first.
   *
   * Refreshing happens in the background: a request never waits on a third-party server, so a slow
   * or blocked feed shows the previous set (or nothing on a cold start) instead of stalling the
   * socket. `refresh()` is there for a caller that genuinely wants to wait, such as a test.
   */
  list(limit = 50): NewsItem[] {
    if (this.stale() && !this.inflight) void this.refresh().catch(() => { /* reported in refresh */ });
    return this.items.slice(0, Math.max(1, Math.min(200, Math.floor(limit))));
  }

  /** Fetch every feed, merge, de-duplicate and sort. Concurrent calls share one run. */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const run = (async () => {
      const doFetch = this.opts.fetchImpl ?? fetch;
      const feeds = this.opts.feeds ?? DEFAULT_FEEDS;
      const timeoutMs = this.opts.timeoutMs ?? 8_000;
      const results = await Promise.all(feeds.map(async (feed) => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        try {
          const res = await doFetch(feed.url, {
            signal: ctl.signal,
            headers: { accept: "application/rss+xml, application/xml, text/xml, */*" },
          });
          if (!res.ok) throw new Error(`${res.status}`);
          return parseFeed(await res.text(), feed.source, this.now);
        } catch (err) {
          // One unreachable feed must not empty the tab.
          this.opts.onError?.(err as Error, `news:${feed.source}`);
          return [] as NewsItem[];
        } finally {
          clearTimeout(t);
        }
      }));

      const merged = new Map<string, NewsItem>();
      for (const list of results) for (const item of list) if (!merged.has(item.id)) merged.set(item.id, item);
      const next = [...merged.values()].sort((a, b) => b.publishedAtMs - a.publishedAtMs);
      // Every feed failing leaves the previous set in place rather than blanking the tab.
      if (next.length > 0) {
        this.items = next.slice(0, this.opts.max ?? 120);
        this.fetchedAtMs = this.now;
      } else if (this.items.length === 0) {
        // Nothing cached and nothing fetched: back off so a blocked network is not hammered.
        this.fetchedAtMs = this.now;
      }
    })();
    this.inflight = run.finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Epoch ms of the last successful fetch; 0 before one. */
  get lastFetchedAtMs(): number { return this.fetchedAtMs; }
}
