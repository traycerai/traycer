import { describe, expect, it } from "vitest";
import type { BrowserTabInfo } from "@traycer/protocol/host/browser/contracts";
import {
  browserTabFaviconUrl,
  browserTabHostname,
  disambiguateSecondaryLabels,
  nextSettledTabIdentity,
  resolveTabTitle,
} from "@/lib/browser-view/browser-tab-display";

function tab(
  overrides: Partial<BrowserTabInfo> & Pick<BrowserTabInfo, "tabId" | "url">,
): BrowserTabInfo {
  return {
    originTier: "dev",
    status: "ready",
    title: null,
    viewed: false,
    drivenBy: [],
    ...overrides,
  };
}

describe("browser-tab-display", () => {
  it("resolves a title, then hostname, then Browser", () => {
    expect(
      resolveTabTitle(
        tab({ tabId: "tab-title", url: "https://app.example", title: "Inbox" }),
      ),
    ).toBe("Inbox");
    expect(
      resolveTabTitle(
        tab({
          tabId: "tab-host",
          url: "https://app.example/path",
          title: "  ",
        }),
      ),
    ).toBe("app.example");
    expect(
      resolveTabTitle(tab({ tabId: "tab-unknown", url: "not a URL" })),
    ).toBe("Browser");
  });

  it("extracts hostnames only from parseable urls", () => {
    expect(browserTabHostname("https://app.example/path")).toBe("app.example");
    expect(browserTabHostname("")).toBeNull();
    expect(browserTabHostname("not a URL")).toBeNull();
  });

  it("builds origin favicons only for http and https urls", () => {
    expect(browserTabFaviconUrl("http://app.example:8080/path")).toBe(
      "http://app.example:8080/favicon.ico",
    );
    expect(browserTabFaviconUrl("https://app.example/path")).toBe(
      "https://app.example/favicon.ico",
    );
    expect(browserTabFaviconUrl("about:blank")).toBeNull();
    expect(browserTabFaviconUrl("not a URL")).toBeNull();
  });

  it("holds settled identity through transient navigation and same-origin title gaps", () => {
    const first = nextSettledTabIdentity(
      null,
      tab({
        tabId: "grille",
        url: "https://thecapitalgrille.com",
        title: "The Capital Grille",
        status: "ready",
      }),
    );
    expect(first.title).toBe("The Capital Grille");
    expect(first.url).toBe("https://thecapitalgrille.com");
    expect(first.faviconUrl).toBe("https://thecapitalgrille.com/favicon.ico");

    const navigating = nextSettledTabIdentity(
      first,
      tab({
        tabId: "grille",
        url: "https://thecapitalgrille.com/menu",
        title: "thecapitalgrille.com",
        status: "navigating",
      }),
    );
    expect(navigating.title).toBe("The Capital Grille");
    expect(navigating.url).toBe("https://thecapitalgrille.com");

    const provisioning = nextSettledTabIdentity(
      first,
      tab({
        tabId: "grille",
        url: "https://thecapitalgrille.com/reservations",
        title: "Loading",
        status: "provisioning",
      }),
    );
    expect(provisioning.title).toBe("The Capital Grille");
    expect(provisioning.url).toBe("https://thecapitalgrille.com");

    const originChange = nextSettledTabIdentity(
      first,
      tab({
        tabId: "grille",
        url: "https://thepier5.com",
        title: "Waterfront",
        status: "navigating",
      }),
    );
    expect(originChange).toEqual(first);

    const cancelled = nextSettledTabIdentity(
      originChange,
      tab({
        tabId: "grille",
        url: "https://thecapitalgrille.com",
        title: null,
        status: "ready",
      }),
    );
    expect(cancelled).toEqual(first);
    expect(cancelled.faviconUrl).toBe(
      "https://thecapitalgrille.com/favicon.ico",
    );

    const settledEmpty = nextSettledTabIdentity(
      navigating,
      tab({
        tabId: "grille",
        url: "https://thecapitalgrille.com/menu",
        title: null,
        status: "ready",
      }),
    );
    expect(settledEmpty.title).toBe("The Capital Grille");
    expect(settledEmpty.hasDocumentTitle).toBe(true);

    const crossOriginHostname = nextSettledTabIdentity(
      first,
      tab({
        tabId: "grille",
        url: "https://www.thecapitalgrille.com/menu",
        title: "thecapitalgrille.com",
        status: "ready",
      }),
    );
    expect(crossOriginHostname).toMatchObject({
      title: "www.thecapitalgrille.com",
      url: "https://www.thecapitalgrille.com/menu",
      faviconUrl: "https://www.thecapitalgrille.com/favicon.ico",
      hasDocumentTitle: false,
    });

    const sameTitleOnNewOrigin = nextSettledTabIdentity(
      first,
      tab({
        tabId: "grille",
        url: "https://thepier5.com",
        title: "The Capital Grille",
        status: "ready",
      }),
    );
    expect(sameTitleOnNewOrigin).toMatchObject({
      title: "The Capital Grille",
      url: "https://thepier5.com",
      faviconUrl: "https://thepier5.com/favicon.ico",
    });
  });

  it("commits hostname identity when a newly-ready tab never had a document title", () => {
    const pending = nextSettledTabIdentity(
      null,
      tab({
        tabId: "new",
        url: "https://www.thecapitalgrille.com",
        title: null,
        status: "navigating",
      }),
    );
    const settled = nextSettledTabIdentity(
      pending,
      tab({
        tabId: "new",
        url: "https://www.thecapitalgrille.com",
        title: "thecapitalgrille.com",
        status: "ready",
      }),
    );
    expect(settled).toMatchObject({
      title: "www.thecapitalgrille.com",
      url: "https://www.thecapitalgrille.com",
      hasDocumentTitle: false,
    });
  });

  it("keeps a generic identity until a new tab's first navigation settles", () => {
    const pending = nextSettledTabIdentity(
      null,
      tab({
        tabId: "new",
        url: "https://www.thecapitalgrille.com",
        title: null,
        status: "navigating",
      }),
    );
    expect(pending).toMatchObject({
      title: "Browser",
      url: "https://www.thecapitalgrille.com",
      faviconUrl: null,
      hasDocumentTitle: false,
    });

    const pendingProvision = nextSettledTabIdentity(
      null,
      tab({
        tabId: "new-provision",
        url: "https://www.thecapitalgrille.com",
        title: "thecapitalgrille.com",
        status: "provisioning",
      }),
    );
    expect(pendingProvision).toMatchObject({
      title: "Browser",
      url: "https://www.thecapitalgrille.com",
      faviconUrl: null,
      hasDocumentTitle: false,
    });
  });

  it("labels every row with its hostname", () => {
    const labels = disambiguateSecondaryLabels([
      {
        key: "live",
        tabId: "tab-live",
        title: "JioHotstar",
        url: "https://www.hotstar.com/live",
      },
      {
        key: "docs",
        tabId: "tab-docs",
        title: "Docs",
        url: "https://example.com/docs",
      },
    ]);
    expect(labels.get("live")).toBe("www.hotstar.com");
    expect(labels.get("docs")).toBe("example.com");
  });

  it("appends the tab-id tail when title and hostname collide", () => {
    const labels = disambiguateSecondaryLabels([
      {
        key: "a",
        tabId: "aaaaaaaa-1111-4aaa-aaaa-aaaabbbbcccc",
        title: "JioHotstar",
        url: "https://www.hotstar.com/live",
      },
      {
        key: "b",
        tabId: "bbbbbbbb-2222-4bbb-bbbb-bbbbddddffff",
        title: "JioHotstar",
        url: "https://www.hotstar.com/sports",
      },
    ]);
    expect(labels.get("a")).toBe("www.hotstar.com (cccc)");
    expect(labels.get("b")).toBe("www.hotstar.com (ffff)");
  });

  it("does not disambiguate matching hosts when titles already differ", () => {
    const labels = disambiguateSecondaryLabels([
      {
        key: "a",
        tabId: "tab-a",
        title: "News",
        url: "https://example.com/news",
      },
      {
        key: "b",
        tabId: "tab-b",
        title: "Weather",
        url: "https://example.com/weather",
      },
    ]);
    expect(labels.get("a")).toBe("example.com");
    expect(labels.get("b")).toBe("example.com");
  });
});
