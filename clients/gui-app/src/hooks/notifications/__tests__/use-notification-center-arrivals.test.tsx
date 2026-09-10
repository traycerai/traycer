import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  computeLiveArrivalKeys,
  useNotificationCenterArrivals,
} from "@/hooks/notifications/use-notification-center-arrivals";
import { occurrenceKeyForNotification } from "@/lib/notifications/notification-occurrence";
import type { MergedNotificationOccurrenceEntry } from "@/stores/notifications/merged-notifications";

/** Build full `{feedId, occurrenceKey}` entries from `feedId@createdAt` keys. */
function entries(
  ...parts: ReadonlyArray<string>
): ReadonlyArray<MergedNotificationOccurrenceEntry> {
  return parts.map((key) => {
    const at = key.indexOf("@");
    return {
      feedId: at === -1 ? key : key.slice(0, at),
      occurrenceKey: key,
    };
  });
}

function occurrenceEntry(input: {
  readonly feedId: string;
  readonly createdAt: number;
  readonly sourceRef: string | null;
}): MergedNotificationOccurrenceEntry {
  return {
    feedId: input.feedId,
    occurrenceKey: occurrenceKeyForNotification(input),
  };
}

describe("computeLiveArrivalKeys mixed-plane ordering", () => {
  // Mixed mode concatenates two ordered lanes - every `local` row precedes
  // every `cloud` row regardless of timestamp, because `updatedAt` means
  // different things in the two origins. A single GLOBAL front made the
  // positional rule unsatisfiable for the trailing lane.

  it("counts a new cloud occurrence that lands behind the whole local lane", () => {
    const previous = entries("host:a@10", "cloud:x@9");
    const current = entries("host:a@10", "cloud:new@11", "cloud:x@9");

    // Pre-fix: the previous front is `host:a` at global index 0, so the cloud
    // arrival at index 1 failed `index < 0` and was read as paginated history
    // - the "N new" affordance never appeared for ANY cloud arrival once a
    // single local row was loaded.
    expect(computeLiveArrivalKeys(previous, current)).toEqual(["cloud:new@11"]);
  });

  it("still refuses an APPENDED cloud page in the same shape", () => {
    // The rule has to keep discriminating, or the fix is just "count
    // everything": an older page lands after its own lane's front.
    const previous = entries("host:a@10", "cloud:x@9");
    const current = entries("host:a@10", "cloud:x@9", "cloud:older@2");

    expect(computeLiveArrivalKeys(previous, current)).toEqual([]);
  });

  it("keeps counting a new local row against the local lane's own front", () => {
    const previous = entries("host:a@10", "cloud:x@9");
    const current = entries("host:new@12", "host:a@10", "cloud:x@9");

    expect(computeLiveArrivalKeys(previous, current)).toEqual(["host:new@12"]);
  });

  it("treats a lane with nothing loaded as a first page, not an arrival", () => {
    // No cloud front to compare against, so the cloud snapshot's first rows
    // are a load rather than a live prepend - the same rule the whole list
    // already had for an empty baseline.
    const previous = entries("host:a@10");
    const current = entries("host:a@10", "cloud:first@99");

    expect(computeLiveArrivalKeys(previous, current)).toEqual([]);
  });
});

describe("computeLiveArrivalKeys", () => {
  it("returns empty when there is no prior baseline", () => {
    expect(
      computeLiveArrivalKeys([], entries("host:a@10", "host:b@5")),
    ).toEqual([]);
  });

  it("counts a live prepend when the prior front is gone but a prior row survives", () => {
    // An authoritative snapshot can drop the previous front and introduce a new
    // row in the SAME pass - another window clearing the old front while a
    // notification lands. The positional reference is not lost when that
    // happens: `host:b@50` is still on screen and still sits behind anything
    // that arrived, so it is the boundary the departed front used to be.
    //
    // This asserted `[]` before, which silently swallowed the "N new"
    // affordance for genuine arrivals whenever a snapshot removed the front.
    expect(
      computeLiveArrivalKeys(
        entries("host:old-front@100", "host:b@50"),
        entries("host:new@200", "host:b@50"),
      ),
    ).toEqual(["host:new@200"]);
  });

  it("returns empty when NO prior row of the lane survives", () => {
    // Wholesale replacement. Nothing positional distinguishes it from a fresh
    // baseline, and announcing a first page as "N new" is the louder mistake.
    expect(
      computeLiveArrivalKeys(
        entries("host:old-front@100", "host:old-b@50"),
        entries("host:new@200", "host:other-new@150"),
      ),
    ).toEqual([]);
  });

  it("counts a live prepend of a brand-new feedId ahead of the prior front", () => {
    expect(
      computeLiveArrivalKeys(
        entries("host:front@100", "host:older@50"),
        entries("host:new@200", "host:front@100", "host:older@50"),
      ),
    ).toEqual(["host:new@200"]);
  });

  it("counts a same-feedId recurrence even when the prior occurrence key is gone", () => {
    // Store holds at most one row per feedId: applyUpsertFrame replaces
    // byId[id] in place, so the old occurrence key never survives into
    // currentEntries. The old key-membership algorithm would return [] here.
    expect(
      computeLiveArrivalKeys(
        entries("host:n-1@100", "host:other@50"),
        entries("host:n-1@200", "host:other@50"),
      ),
    ).toEqual(["host:n-1@200"]);
  });

  it("does not count a content-only retitle at the same createdAt", () => {
    // Same feedId + same occurrenceKey (createdAt unchanged) - only title/body
    // content would have changed; that is not a live arrival.
    expect(
      computeLiveArrivalKeys(
        entries("host:n-1@100", "host:other@50"),
        entries("host:n-1@100", "host:other@50"),
      ),
    ).toEqual([]);
  });

  it("counts a same-feedId same-createdAt re-open under a new sourceRef", () => {
    // Same-millisecond prompt supersede: feedId + createdAt stable, sourceRef
    // changes → new occurrence key → "N new" must fire.
    const prior = occurrenceEntry({
      feedId: "host:approval.requested:chat-1",
      createdAt: 100,
      sourceRef: "refA",
    });
    const reopened = occurrenceEntry({
      feedId: "host:approval.requested:chat-1",
      createdAt: 100,
      sourceRef: "refB",
    });
    const other = occurrenceEntry({
      feedId: "host:other",
      createdAt: 50,
      sourceRef: "other",
    });
    expect(computeLiveArrivalKeys([prior, other], [reopened, other])).toEqual([
      reopened.occurrenceKey,
    ]);
  });

  it("never treats a paginated older page appended at the tail as live", () => {
    expect(
      computeLiveArrivalKeys(
        entries("host:front@100", "host:mid@50"),
        entries("host:front@100", "host:mid@50", "host:older-page@10"),
      ),
    ).toEqual([]);
  });

  it("returns every brand-new key strictly ahead of the prior front feedId", () => {
    expect(
      computeLiveArrivalKeys(
        entries("host:front@100"),
        entries(
          "host:new-a@300",
          "host:new-b@200",
          "host:front@100",
          "host:older-page@10",
        ),
      ),
    ).toEqual(["host:new-a@300", "host:new-b@200"]);
  });

  it("still detects brand-new feedIds when the previous front itself recurred", () => {
    // Reference point is previous front's feedId (not its occurrence key), so
    // the positional split remains well-defined even when the front row's own
    // occurrence key changed in the same update.
    expect(
      computeLiveArrivalKeys(
        entries("host:front@100", "host:older@50"),
        entries(
          "host:new-a@300",
          "host:new-b@250",
          "host:front@200",
          "host:older@50",
        ),
      ),
    ).toEqual(["host:new-a@300", "host:new-b@250", "host:front@200"]);
  });
});

describe("useNotificationCenterArrivals", () => {
  it("joins arrivals into the baseline silently while at top (no count)", () => {
    const { result, rerender } = renderHook(
      (props: {
        readonly isAtTop: boolean;
        readonly fullOrder: ReadonlyArray<MergedNotificationOccurrenceEntry>;
        readonly visibleOccurrenceKeys: ReadonlyArray<string>;
      }) => useNotificationCenterArrivals(props),
      {
        initialProps: {
          isAtTop: true,
          fullOrder: entries("host:a@100"),
          visibleOccurrenceKeys: ["host:a@100"],
        },
      },
    );

    expect(result.current.newCount).toBe(0);

    rerender({
      isAtTop: true,
      fullOrder: entries("host:new@200", "host:a@100"),
      visibleOccurrenceKeys: ["host:new@200", "host:a@100"],
    });

    expect(result.current.newCount).toBe(0);
  });

  it("accumulates live arrivals while scrolled and intersects with visibility", () => {
    const { result, rerender } = renderHook(
      (props: {
        readonly isAtTop: boolean;
        readonly fullOrder: ReadonlyArray<MergedNotificationOccurrenceEntry>;
        readonly visibleOccurrenceKeys: ReadonlyArray<string>;
      }) => useNotificationCenterArrivals(props),
      {
        initialProps: {
          isAtTop: false,
          fullOrder: entries("host:a@100", "global:collab@50"),
          visibleOccurrenceKeys: ["host:a@100", "global:collab@50"],
        },
      },
    );

    // First non-null previousEntries is the baseline - no arrivals yet.
    expect(result.current.newCount).toBe(0);

    rerender({
      isAtTop: false,
      fullOrder: entries(
        "host:task-new@300",
        "global:collab-new@250",
        "host:a@100",
        "global:collab@50",
      ),
      visibleOccurrenceKeys: [
        "host:task-new@300",
        "global:collab-new@250",
        "host:a@100",
        "global:collab@50",
      ],
    });

    expect(result.current.newCount).toBe(2);

    // Filter hides collaboration: intersection narrows the count, never mints
    // pre-baseline rows as new.
    rerender({
      isAtTop: false,
      fullOrder: entries(
        "host:task-new@300",
        "global:collab-new@250",
        "host:a@100",
        "global:collab@50",
      ),
      visibleOccurrenceKeys: ["host:task-new@300", "host:a@100"],
    });

    expect(result.current.newCount).toBe(1);

    // Turning collaboration back on restores the already-arrived key.
    rerender({
      isAtTop: false,
      fullOrder: entries(
        "host:task-new@300",
        "global:collab-new@250",
        "host:a@100",
        "global:collab@50",
      ),
      visibleOccurrenceKeys: [
        "host:task-new@300",
        "global:collab-new@250",
        "host:a@100",
        "global:collab@50",
      ],
    });

    expect(result.current.newCount).toBe(2);
  });

  it("counts a same-feedId recurrence while scrolled (store-realistic single row)", () => {
    const { result, rerender } = renderHook(
      (props: {
        readonly isAtTop: boolean;
        readonly fullOrder: ReadonlyArray<MergedNotificationOccurrenceEntry>;
        readonly visibleOccurrenceKeys: ReadonlyArray<string>;
      }) => useNotificationCenterArrivals(props),
      {
        initialProps: {
          isAtTop: false,
          fullOrder: entries("host:approval@100"),
          visibleOccurrenceKeys: ["host:approval@100"],
        },
      },
    );

    expect(result.current.newCount).toBe(0);

    // Real store path: same feedId, only the new occurrence key remains.
    rerender({
      isAtTop: false,
      fullOrder: entries("host:approval@200"),
      visibleOccurrenceKeys: ["host:approval@200"],
    });

    expect(result.current.newCount).toBe(1);
  });

  it("counts a same-id same-createdAt new-sourceRef arrival while scrolled", () => {
    const prior = occurrenceEntry({
      feedId: "host:approval.requested:chat-1",
      createdAt: 100,
      sourceRef: "refA",
    });
    const reopened = occurrenceEntry({
      feedId: "host:approval.requested:chat-1",
      createdAt: 100,
      sourceRef: "refB",
    });

    const { result, rerender } = renderHook(
      (props: {
        readonly isAtTop: boolean;
        readonly fullOrder: ReadonlyArray<MergedNotificationOccurrenceEntry>;
        readonly visibleOccurrenceKeys: ReadonlyArray<string>;
      }) => useNotificationCenterArrivals(props),
      {
        initialProps: {
          isAtTop: false,
          fullOrder: [prior],
          visibleOccurrenceKeys: [prior.occurrenceKey],
        },
      },
    );

    expect(result.current.newCount).toBe(0);

    rerender({
      isAtTop: false,
      fullOrder: [reopened],
      visibleOccurrenceKeys: [reopened.occurrenceKey],
    });

    expect(result.current.newCount).toBe(1);
  });

  it("does not promote a pre-baseline row to new when a filter reveals it", () => {
    const { result, rerender } = renderHook(
      (props: {
        readonly isAtTop: boolean;
        readonly fullOrder: ReadonlyArray<MergedNotificationOccurrenceEntry>;
        readonly visibleOccurrenceKeys: ReadonlyArray<string>;
      }) => useNotificationCenterArrivals(props),
      {
        initialProps: {
          isAtTop: false,
          fullOrder: entries("host:a@100", "global:hidden@50"),
          // Collaboration filtered out at baseline.
          visibleOccurrenceKeys: ["host:a@100"],
        },
      },
    );

    expect(result.current.newCount).toBe(0);

    // Reveal the pre-existing collab row via filter - must stay at 0.
    rerender({
      isAtTop: false,
      fullOrder: entries("host:a@100", "global:hidden@50"),
      visibleOccurrenceKeys: ["host:a@100", "global:hidden@50"],
    });

    expect(result.current.newCount).toBe(0);
  });

  it("clears the count when isAtTop becomes true without an order change", () => {
    const { result, rerender } = renderHook(
      (props: {
        readonly isAtTop: boolean;
        readonly fullOrder: ReadonlyArray<MergedNotificationOccurrenceEntry>;
        readonly visibleOccurrenceKeys: ReadonlyArray<string>;
      }) => useNotificationCenterArrivals(props),
      {
        initialProps: {
          isAtTop: false,
          fullOrder: entries("host:a@100"),
          visibleOccurrenceKeys: ["host:a@100"],
        },
      },
    );

    rerender({
      isAtTop: false,
      fullOrder: entries("host:new@200", "host:a@100"),
      visibleOccurrenceKeys: ["host:new@200", "host:a@100"],
    });
    expect(result.current.newCount).toBe(1);

    rerender({
      isAtTop: true,
      fullOrder: entries("host:new@200", "host:a@100"),
      visibleOccurrenceKeys: ["host:new@200", "host:a@100"],
    });
    expect(result.current.newCount).toBe(0);
  });

  it("reveal() clears the arrival set without requiring isAtTop", () => {
    const { result, rerender } = renderHook(
      (props: {
        readonly isAtTop: boolean;
        readonly fullOrder: ReadonlyArray<MergedNotificationOccurrenceEntry>;
        readonly visibleOccurrenceKeys: ReadonlyArray<string>;
      }) => useNotificationCenterArrivals(props),
      {
        initialProps: {
          isAtTop: false,
          fullOrder: entries("host:a@100"),
          visibleOccurrenceKeys: ["host:a@100"],
        },
      },
    );

    rerender({
      isAtTop: false,
      fullOrder: entries("host:new@200", "host:a@100"),
      visibleOccurrenceKeys: ["host:new@200", "host:a@100"],
    });
    expect(result.current.newCount).toBe(1);

    act(() => {
      result.current.reveal();
    });
    expect(result.current.newCount).toBe(0);
  });

  it("does not count a tail append as live while scrolled", () => {
    const { result, rerender } = renderHook(
      (props: {
        readonly isAtTop: boolean;
        readonly fullOrder: ReadonlyArray<MergedNotificationOccurrenceEntry>;
        readonly visibleOccurrenceKeys: ReadonlyArray<string>;
      }) => useNotificationCenterArrivals(props),
      {
        initialProps: {
          isAtTop: false,
          fullOrder: entries("host:a@100", "host:b@50"),
          visibleOccurrenceKeys: ["host:a@100", "host:b@50"],
        },
      },
    );

    rerender({
      isAtTop: false,
      fullOrder: entries("host:a@100", "host:b@50", "host:page@10"),
      visibleOccurrenceKeys: ["host:a@100", "host:b@50", "host:page@10"],
    });

    expect(result.current.newCount).toBe(0);
  });
});
