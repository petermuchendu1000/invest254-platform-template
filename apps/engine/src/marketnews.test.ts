import { test } from "node:test";
import assert from "node:assert/strict";
import { MarketNews, parseFeed, decodeEntities, toPlainText, type NewsItem } from "./marketnews.js";

/**
 * The news feed is the one place the engine reads third-party text, so these tests are about
 * resilience and safety rather than happy-path shape: malformed XML, markup inside titles, missing
 * dates, unreachable feeds, and the socket never being made to wait on someone else's server.
 *
 * Nothing here touches the network — every fetch is injected.
 */

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example feed</title>
  <item>
    <title>Gold climbs as the dollar slips</title>
    <link>https://example.com/a</link>
    <pubDate>Tue, 30 Sep 2025 09:15:00 GMT</pubDate>
    <description>Bullion rose 1.2% &amp;mdash; see &lt;b&gt;analysis&lt;/b&gt;.</description>
  </item>
  <item>
    <title><![CDATA[Fed minutes & the "dot plot"]]></title>
    <link>https://example.com/b</link>
    <pubDate>Tue, 30 Sep 2025 08:00:00 GMT</pubDate>
    <description><![CDATA[<p>Rates held.</p>]]></description>
  </item>
</channel></rss>`;

test("parses a feed into items, newest-first once sorted, with links and dates", () => {
  const items = parseFeed(RSS, "Forex");
  assert.equal(items.length, 2);
  assert.equal(items[0]!.title, "Gold climbs as the dollar slips");
  assert.equal(items[0]!.url, "https://example.com/a");
  assert.equal(items[0]!.source, "Forex");
  assert.equal(items[0]!.publishedAtMs, Date.parse("Tue, 30 Sep 2025 09:15:00 GMT"));
  assert.equal(items[1]!.title, 'Fed minutes & the "dot plot"', "CDATA and entities decode");
});

test("markup is stripped from titles and summaries — the UI must never be handed HTML", () => {
  const items = parseFeed(RSS, "Forex");
  // The feed ESCAPED its markup (`&lt;b&gt;`). Stripping before decoding would have found no tags
  // and then handed the decoded "<b>" straight through — the order is the whole point.
  assert.equal(items[0]!.summary, "Bullion rose 1.2% &mdash; see analysis .");
  assert.ok(!items[0]!.summary.includes("<b>"), "escaped markup must not be restored after stripping");
  assert.equal(items[1]!.summary, "Rates held.");
  const nasty = parseFeed(
    `<rss><channel><item><title><![CDATA[<img src=x onerror=alert(1)>Headline]]></title>` +
    `<link>https://example.com/x</link></item></channel></rss>`, "X",
  );
  assert.equal(nasty[0]!.title, "Headline");
  assert.ok(!nasty[0]!.title.includes("<"), "no tag may survive");
});

test("entity decoding resolves &amp; LAST, so escaped entities stay escaped", () => {
  // "&amp;lt;" is a feed saying the literal text "&lt;" — decoding &amp; first would turn it into
  // a real "<" and smuggle markup through the stripper.
  assert.equal(decodeEntities("&amp;lt;b&amp;gt;"), "&lt;b&gt;");
  assert.equal(decodeEntities("a &amp; b"), "a & b");
  assert.equal(decodeEntities("&#8212;&#x2014;"), "——");
  assert.equal(decodeEntities("&#99999999;"), "", "an out-of-range code point is dropped, not thrown");
});

test("long text is capped with an ellipsis rather than flooding the panel", () => {
  const long = "x".repeat(900);
  const out = toPlainText(long, 50);
  assert.equal(out.length, 50);
  assert.ok(out.endsWith("…"));
});

test("items without a usable link are skipped", () => {
  const items = parseFeed(
    `<rss><channel>
      <item><title>No link at all</title></item>
      <item><title>Script link</title><link>javascript:alert(1)</link></item>
      <item><title>Good</title><link>https://example.com/ok</link></item>
    </channel></rss>`, "X",
  );
  assert.deepEqual(items.map((i) => i.title), ["Good"]);
});

test("an item with no date sorts as now, not 1970", () => {
  const now = 1_700_000_000_000;
  const items = parseFeed(`<rss><channel><item><title>T</title><link>https://e.com/1</link></item></channel></rss>`, "X", now);
  assert.equal(items[0]!.publishedAtMs, now);
});

test("malformed XML yields nothing instead of throwing", () => {
  assert.deepEqual(parseFeed("<rss><channel><item><title>unclosed", "X"), []);
  assert.deepEqual(parseFeed("", "X"), []);
  assert.deepEqual(parseFeed("not xml at all", "X"), []);
});

test("feeds are merged and de-duplicated by link, newest first", async () => {
  const a = `<rss><channel><item><title>A</title><link>https://e.com/1</link><pubDate>Tue, 30 Sep 2025 08:00:00 GMT</pubDate></item></channel></rss>`;
  const b = `<rss><channel>
    <item><title>A duplicate</title><link>https://e.com/1</link><pubDate>Tue, 30 Sep 2025 08:00:00 GMT</pubDate></item>
    <item><title>B</title><link>https://e.com/2</link><pubDate>Tue, 30 Sep 2025 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const news = new MarketNews({
    feeds: [{ source: "A", url: "https://a" }, { source: "B", url: "https://b" }],
    fetchImpl: (async (url: string) => ok(url === "https://a" ? a : b)) as unknown as typeof fetch,
  });
  await news.refresh();
  const items = news.list();
  assert.equal(items.length, 2, "the shared link appears once");
  assert.deepEqual(items.map((i: NewsItem) => i.title), ["B", "A"], "newest first");
});

test("one unreachable feed does not empty the tab", async () => {
  const good = `<rss><channel><item><title>Still here</title><link>https://e.com/1</link></item></channel></rss>`;
  const errs: string[] = [];
  const news = new MarketNews({
    feeds: [{ source: "Dead", url: "https://dead" }, { source: "Live", url: "https://live" }],
    fetchImpl: (async (url: string) => {
      if (url === "https://dead") throw new Error("ECONNREFUSED");
      return ok(good);
    }) as unknown as typeof fetch,
    onError: (_e, ctx) => errs.push(ctx),
  });
  await news.refresh();
  assert.deepEqual(news.list().map((i) => i.title), ["Still here"]);
  assert.deepEqual(errs, ["news:Dead"]);
});

test("every feed failing keeps the last good set rather than blanking it", async () => {
  const good = `<rss><channel><item><title>Cached</title><link>https://e.com/1</link></item></channel></rss>`;
  let fail = false;
  const news = new MarketNews({
    ttlMs: 0,
    feeds: [{ source: "F", url: "https://f" }],
    fetchImpl: (async () => { if (fail) throw new Error("blocked"); return ok(good); }) as unknown as typeof fetch,
  });
  await news.refresh();
  fail = true;
  await news.refresh();
  assert.deepEqual(news.list().map((i) => i.title), ["Cached"], "a blocked network shows stale news, not none");
});

test("an HTTP error status is treated as a failure, not parsed as a feed", async () => {
  const news = new MarketNews({
    feeds: [{ source: "F", url: "https://f" }],
    fetchImpl: (async () => ({ ok: false, status: 429, text: async () => "<html>rate limited</html>" })) as unknown as typeof fetch,
  });
  await news.refresh();
  assert.deepEqual(news.list(), []);
});

test("list() never waits on the network — a hanging feed returns immediately", async () => {
  let release: null | (() => void) = null;
  const fire = () => { if (release) release(); };
  const news = new MarketNews({
    feeds: [{ source: "Slow", url: "https://slow" }],
    fetchImpl: (async () => {
      await new Promise<void>((r) => { release = r; });
      return ok(`<rss><channel><item><title>Late</title><link>https://e.com/1</link></item></channel></rss>`);
    }) as unknown as typeof fetch,
  });
  const started = Date.now();
  assert.deepEqual(news.list(), [], "a cold cache returns empty rather than blocking");
  assert.ok(Date.now() - started < 50, "list() must not await the fetch");
  fire();
});

test("concurrent refreshes share one run", async () => {
  let calls = 0;
  const news = new MarketNews({
    feeds: [{ source: "F", url: "https://f" }],
    fetchImpl: (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return ok(`<rss><channel><item><title>T</title><link>https://e.com/1</link></item></channel></rss>`);
    }) as unknown as typeof fetch,
  });
  await Promise.all([news.refresh(), news.refresh(), news.refresh()]);
  assert.equal(calls, 1);
});

function ok(body: string) {
  return { ok: true, status: 200, text: async () => body } as unknown as Response;
}
