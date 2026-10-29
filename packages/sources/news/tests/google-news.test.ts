import { describe, expect, it } from "vitest";

import {
  decodeXml,
  googleNewsUrl,
  parseGoogleNewsRss,
} from "../src/google-news.js";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<item>
  <title>Apple beats expectations - Reuters</title>
  <link>https://news.google.com/rss/articles/abc?oc=5</link>
  <pubDate>Tue, 27 Oct 2026 14:00:00 GMT</pubDate>
  <description>&lt;a href="https://news.google.com/rss/articles/abc"&gt;Apple beats expectations&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Reuters&lt;/font&gt;</description>
  <source url="https://www.reuters.com">Reuters</source>
</item>
<item>
  <title>Old story - Example</title>
  <link>https://news.google.com/rss/articles/old?oc=5</link>
  <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
  <description>Old</description>
  <source url="https://example.com">Example</source>
</item>
<item>
  <title>Duplicate - Reuters</title>
  <link>https://news.google.com/rss/articles/abc?oc=5</link>
  <pubDate>Tue, 27 Oct 2026 15:00:00 GMT</pubDate>
  <source url="https://www.reuters.com">Reuters</source>
</item>
</channel></rss>`;

describe("Google News RSS", () => {
  it("builds locale-aware search URLs", () => {
    const url = new URL(googleNewsUrl("茅台", "zh-CN"));
    expect(url.searchParams.get("hl")).toBe("zh-CN");
    expect(url.searchParams.get("gl")).toBe("CN");
    expect(url.searchParams.get("ceid")).toBe("CN:zh-Hans");
    expect(url.searchParams.get("q")).toBe("茅台");
  });

  it("parses items, strips publisher suffix and dedupes URLs", () => {
    const articles = parseGoogleNewsRss(RSS, {
      now: new Date("2026-10-29T00:00:00Z"),
      sinceDays: 7,
    });
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      title: "Apple beats expectations",
      url: "https://news.google.com/rss/articles/abc?oc=5",
      publisher: "Reuters",
      publishedAt: "2026-10-27T14:00:00.000Z",
    });
    expect(articles[0]!.summary).toContain("Apple beats expectations");
    expect(articles[0]!.summary).not.toContain("<a");
  });

  it("applies the recency window and limit", () => {
    const articles = parseGoogleNewsRss(RSS, {
      now: new Date("2026-10-29T00:00:00Z"),
      sinceDays: 7,
      limit: 1,
    });
    expect(articles).toHaveLength(1);
  });

  it("decodes XML entities and numeric references", () => {
    expect(decodeXml("A &amp; B &#39;x&#39; &#x4E2D;")).toBe("A & B 'x' 中");
  });
});
