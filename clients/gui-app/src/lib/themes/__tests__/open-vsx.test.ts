// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  removeNativeAbortHelpers,
  signalOfLastFetch,
  stubHangingFetch,
} from "@traycer-clients/shared/auth/__tests__/no-native-abort-helpers";
import { searchOpenVsxThemes } from "../open-vsx";

function searchResponse(): Response {
  return new Response(
    JSON.stringify({
      extensions: [
        {
          namespace: "acme",
          name: "midnight",
          version: "1.0.0",
          displayName: "Midnight",
          description: "A dark theme",
          downloadCount: 42,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("searchOpenVsxThemes on a WebView without AbortSignal.timeout or AbortSignal.any (iOS 15.5)", () => {
  beforeEach(() => {
    removeNativeAbortHelpers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("still makes the search request and parses the extensions", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(searchResponse()),
    );
    vi.stubGlobal("fetch", fetchMock);

    const extensions = await searchOpenVsxThemes(
      "midnight",
      "relevance",
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(extensions).toMatchObject([
      { id: "acme.midnight", name: "Midnight" },
    ]);
  });

  it("aborts a search that never answers after 15 s, rejecting with the timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = stubHangingFetch();

    const pending = searchOpenVsxThemes(
      "midnight",
      "relevance",
      new AbortController().signal,
    );
    const outcome = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    const signal = signalOfLastFetch(fetchMock);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(signal.aborted).toBe(true);
    await outcome;
  });

  it("aborts the search when the caller's signal aborts, well before the timeout", async () => {
    const fetchMock = stubHangingFetch();
    const caller = new AbortController();

    const pending = searchOpenVsxThemes("midnight", "relevance", caller.signal);
    const outcome = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    const signal = signalOfLastFetch(fetchMock);
    expect(signal.aborted).toBe(false);

    caller.abort();

    expect(signal.aborted).toBe(true);
    await outcome;
  });

  it("gives an exact-identity lookup the same deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = stubHangingFetch();

    const pending = searchOpenVsxThemes(
      "acme.midnight",
      "relevance",
      new AbortController().signal,
    );
    const outcome = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    const signal = signalOfLastFetch(fetchMock);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://open-vsx.org/api/acme/midnight",
      expect.anything(),
    );

    await vi.advanceTimersByTimeAsync(15_000);

    expect(signal.aborted).toBe(true);
    await outcome;
  });

  it("leaves no timer behind once the search has settled", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(searchResponse())),
    );

    await searchOpenVsxThemes(
      "midnight",
      "relevance",
      new AbortController().signal,
    );

    expect(vi.getTimerCount()).toBe(0);
  });
});
