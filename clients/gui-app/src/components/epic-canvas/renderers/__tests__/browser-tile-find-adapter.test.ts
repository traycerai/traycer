import { describe, expect, it } from "vitest";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import type { BrowserViewFindRequest } from "@traycer-clients/shared/platform/browser-view";
import { createBrowserTileFindAdapter } from "../browser-tile-find-adapter";

/**
 * Records `findInPage` calls. `FakeBrowserViewBridge`'s own `findInPage` is a
 * no-op stub shared by suites that don't care about its arguments; this
 * suite's whole point is those arguments, so it subclasses rather than
 * teaching the shared fake to track calls nobody else needs.
 */
class RecordingBrowserViewBridge extends FakeBrowserViewBridge {
  readonly findInPageCalls: BrowserViewFindRequest[] = [];

  override findInPage(input: BrowserViewFindRequest): Promise<void> {
    this.findInPageCalls.push(input);
    return Promise.resolve();
  }
}

function tileKey() {
  return {
    viewTabId: "tab-1",
    paneId: "pane-1",
    tileInstanceId: "tile-1",
    pageSessionId: "session-1",
  };
}

describe("createBrowserTileFindAdapter", () => {
  it("begins a new finding session on search: findNext true, forward true", () => {
    const browserView = new RecordingBrowserViewBridge();
    const adapter = createBrowserTileFindAdapter({
      browserView,
      tileKey: tileKey(),
    });

    void adapter.search({ requestId: 1, query: "foo", matchCase: false });

    expect(browserView.findInPageCalls).toHaveLength(1);
    expect(browserView.findInPageCalls[0]).toMatchObject({
      query: "foo",
      forward: true,
      findNext: true,
    });
    // Guards the original bug: search must never open its session as a
    // follow-up request, or results lag a keystroke behind the query.
    expect(browserView.findInPageCalls[0]?.findNext).not.toBe(false);
  });

  it("advances the active session forward on next(): findNext false, forward true", () => {
    const browserView = new RecordingBrowserViewBridge();
    const adapter = createBrowserTileFindAdapter({
      browserView,
      tileKey: tileKey(),
    });
    void adapter.search({ requestId: 1, query: "foo", matchCase: false });

    void adapter.next();

    expect(browserView.findInPageCalls).toHaveLength(2);
    expect(browserView.findInPageCalls[1]).toMatchObject({
      query: "foo",
      forward: true,
      findNext: false,
    });
  });

  it("advances the active session backward on previous(): findNext false, forward false", () => {
    const browserView = new RecordingBrowserViewBridge();
    const adapter = createBrowserTileFindAdapter({
      browserView,
      tileKey: tileKey(),
    });
    void adapter.search({ requestId: 1, query: "foo", matchCase: false });

    void adapter.previous();

    expect(browserView.findInPageCalls).toHaveLength(2);
    expect(browserView.findInPageCalls[1]).toMatchObject({
      query: "foo",
      forward: false,
      findNext: false,
    });
  });
});
