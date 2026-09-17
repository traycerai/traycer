export type BrowserSearchEngine = "google" | "duckduckgo" | "bing" | "kagi";

export const BROWSER_SEARCH_ENGINE_LABELS: Record<BrowserSearchEngine, string> =
  {
    google: "Google",
    duckduckgo: "DuckDuckGo",
    bing: "Bing",
    kagi: "Kagi",
  };

export function isBrowserSearchEngine(
  value: unknown,
): value is BrowserSearchEngine {
  return (
    value === "google" ||
    value === "duckduckgo" ||
    value === "bing" ||
    value === "kagi"
  );
}

const SEARCH_URLS: Record<BrowserSearchEngine, string> = {
  google: "https://www.google.com/search",
  duckduckgo: "https://duckduckgo.com/",
  bing: "https://www.bing.com/search",
  kagi: "https://kagi.com/search",
};

export function browserSearchUrl(
  query: string,
  engine: BrowserSearchEngine,
): string {
  const url = new URL(SEARCH_URLS[engine]);
  url.searchParams.set("q", query);
  return url.href;
}
