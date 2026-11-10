import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useHostMentionEntries } from "@/hooks/composer/use-host-mention-entries";
import type {
  RankedRootSearch,
  RootSearchCandidate,
} from "@/lib/composer/mentions/root-search-ranking";

const hosts = [{ hostId: "host-offline-42", label: "Studio Laptop" }];
const empty: RankedRootSearch = {
  entries: [],
  matchedCount: 0,
  candidates: [],
};

afterEach(cleanup);

describe("host mention entries", () => {
  it("finds an unavailable host by name and id and retains its identity", () => {
    const { result, rerender } = renderHook(
      ({ query }) =>
        useHostMentionEntries({ kind: "root" }, query, empty, {
          hosts,
          answered: true,
        }),
      { initialProps: { query: "studio" } },
    );
    expect(result.current.entries[0]?.action).toMatchObject({
      kind: "complete",
      mention: {
        contextType: "host",
        hostId: "host-offline-42",
        label: "Studio Laptop",
      },
    });
    expect(result.current.matchedCount).toBe(1);
    rerender({ query: "OFFLINE-42" });
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "host:host-offline-42",
    ]);
    rerender({ query: "unrelated" });
    expect(result.current.entries).toEqual([]);
  });

  it("ranks other provider matches ahead of a weaker host match", () => {
    const { result, rerender } = renderHook(
      ({ existing }) =>
        useHostMentionEntries({ kind: "root" }, "studio", existing, {
          hosts,
          answered: true,
        }),
      { initialProps: { existing: empty } },
    );
    const host = result.current.entries[0];
    const candidate: RootSearchCandidate = {
      entry: {
        ...host,
        id: "task:1",
        label: "studio",
        description: "",
        searchText: null,
      },
      providerId: "epic",
      path: null,
      pickedAt: null,
    };
    rerender({
      existing: {
        entries: [candidate.entry],
        candidates: [candidate],
        matchedCount: 1,
      },
    });
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "task:1",
      "host:host-offline-42",
    ]);
    expect(result.current.matchedCount).toBe(2);
  });
});
