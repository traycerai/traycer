import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EpicDurabilityBadge } from "../epic-durability-badge";
import type {
  EpicCloudFreshness,
  EpicDurabilityPauseReasonV15,
  EpicDurabilityStatusV15,
  EpicLocalProtection,
  EpicPromotionState,
} from "@traycer/protocol/host/epic/subscribe";

/**
 * Typed through the protocol union rather than an `as` assertion on the seed
 * value: `no-unnecessary-type-assertion` autofixes such an assertion away, and
 * the widened inference that replaces it makes the `null` reassignment below a
 * type error. The type argument states the same intent where no fixer reaches.
 */
const durability = vi.hoisted<{
  status: EpicDurabilityStatusV15 | null;
  pauseReason: EpicDurabilityPauseReasonV15 | null;
  promotionState: EpicPromotionState | null;
  /**
   * `null` is a PRE-`@1.4` peer, which is what every case written before the
   * s5 status pass assumed - and it keeps their exact rendering. The new cases
   * set a real value, because at `@1.4` this key is always present.
   */
  localProtection: EpicLocalProtection | null;
  /**
   * `null` is a host that said NOTHING about freshness, which is every case
   * written before `s5-mirror-first-serving` - and, at `@1.4`, every epic for
   * which the question does not apply. Those cases keep their exact
   * rendering, which is what makes the freshness half additive.
   */
  cloudFreshness: EpicCloudFreshness | null;
  /**
   * Whether the fixture's peer negotiated `epic.subscribe@1.5`. Defaults to
   * TRUE because that is what every case in this suite is describing - a host
   * that speaks the durability legs. The pre-`@1.4` peer is its own case and
   * sets it false explicitly.
   */
  peerSpeaksDurabilityLegs: boolean;
}>(() => ({
  status: "paused",
  pauseReason: "access-revoked",
  promotionState: null,
  localProtection: null,
  cloudFreshness: null,
  peerSpeaksDurabilityLegs: true,
}));

// `deriveEpicDurabilityView` is the real implementation, deliberately: it IS
// the class-level correction this ticket makes, so a stub of it here would
// leave the badge's own reading of unknown untested while looking covered.
vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return {
    deriveEpicDurabilityView: actual.deriveEpicDurabilityView,
    useEpicDurabilityView: () =>
      actual.deriveEpicDurabilityView(
        durability.status,
        durability.localProtection,
        durability.peerSpeaksDurabilityLegs,
      ),
    useEpicDurabilityPauseReason: () => durability.pauseReason,
    useEpicDurabilityPromotionState: () => durability.promotionState,
    // The REAL derivation again, for the same reason: turning the wire's
    // structural union into a view is where "absent is not current" is
    // actually decided, so stubbing it would leave that untested.
    deriveEpicCloudFreshnessView: actual.deriveEpicCloudFreshnessView,
    useEpicCloudFreshnessView: () =>
      actual.deriveEpicCloudFreshnessView(durability.cloudFreshness),
    useEpicArtifactRecords: () => [],
    useEpicSnapshotMeta: () => null,
  };
});

vi.mock("@/hooks/epic/use-epic-export-artifacts-mutation", () => ({
  useEpicExportArtifacts: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    authnBaseUrl: "https://authn.test",
    openExternalLink: vi.fn(),
  }),
}));

/**
 * The badge opens the upgrade link through `useRunnerOpenExternalLink` rather
 * than calling the bridge directly, so it needs a query client like every
 * other backend-touching surface in this app.
 */
function renderBadge(): RenderResult {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <EpicDurabilityBadge />
    </QueryClientProvider>,
  );
}

describe("<EpicDurabilityBadge />", () => {
  afterEach(() => {
    cleanup();
    durability.cloudFreshness = null;
  });

  it("renders the revoked-access export surface, not the upgrade story", () => {
    durability.status = "paused";
    durability.pauseReason = "access-revoked";
    durability.promotionState = null;

    renderBadge();

    expect(screen.getByText("Sync blocked — access revoked")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export artifacts" }),
    ).toBeTruthy();
    expect(screen.queryByText("Upgrade")).toBeNull();
  });

  it("offers the export remedy on a preserved orphan, not just the warning copy", () => {
    // The other half of `s5-orphaned-epic-recovery`. Making the epic listable
    // again is pointless if the only thing waiting at the end of the click is
    // a label: the cloud object is gone, so getting the never-uploaded bytes
    // out IS the recovery.
    durability.status = "paused";
    durability.pauseReason = "orphaned-local-edits-after-cloud-delete";
    durability.promotionState = null;

    renderBadge();

    expect(
      screen.getByText("Deleted in cloud — local edits kept here"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export artifacts" }),
    ).toBeTruthy();
    // Upgrading buys nothing here - the cloud copy does not come back.
    expect(screen.queryByText("Upgrade")).toBeNull();
  });

  it("renders upgrade only for the entitlement-lapsed reason", () => {
    durability.status = "paused";
    durability.pauseReason = "entitlement-lapsed";
    durability.promotionState = null;

    renderBadge();

    expect(screen.getByText("Sync paused")).toBeTruthy();
    expect(screen.getByText("Upgrade")).toBeTruthy();
    expect(screen.queryByText("Export artifacts")).toBeNull();
  });

  it("keeps an omitted pause reason neutral with no call to action", () => {
    durability.status = "paused";
    durability.pauseReason = null;
    durability.promotionState = null;

    renderBadge();

    expect(screen.getByText("Sync paused")).toBeTruthy();
    expect(screen.queryByText("Upgrade")).toBeNull();
    expect(screen.queryByText("Export artifacts")).toBeNull();
  });

  it("renders a visibly distinct pending state for promotionState=pending, not live Promoting copy", () => {
    durability.status = "promoting";
    durability.pauseReason = null;
    durability.promotionState = "pending";

    renderBadge();

    const badge = screen.getByTestId("epic-durability-badge");
    expect(badge.getAttribute("data-promotion-state")).toBe("pending");
    expect(screen.getByText("Promotion pending")).toBeTruthy();
    expect(screen.queryByText("Promoting to cloud")).toBeNull();
  });

  it("keeps the live Promoting to cloud copy for promotionState=active", () => {
    durability.status = "promoting";
    durability.pauseReason = null;
    durability.promotionState = "active";

    renderBadge();

    const badge = screen.getByTestId("epic-durability-badge");
    expect(badge.getAttribute("data-promotion-state")).toBe("active");
    expect(screen.getByText("Promoting to cloud")).toBeTruthy();
    expect(screen.queryByText("Promotion pending")).toBeNull();
  });

  // ── `s5-status-truthfulness`: unknown must not render as fine ───────────
  //
  // Every case below drew NOTHING on the pre-fix code - the component's first
  // statement was `if (status === null) return null;` - so an unprotected or
  // indeterminate session was pixel-identical to a protected one.

  it("renders an explicit indeterminate badge for durability=unknown", () => {
    durability.status = "unknown";
    durability.pauseReason = null;
    durability.promotionState = null;
    durability.localProtection = "unknown";

    renderBadge();

    expect(screen.getByText("Storage status unknown")).toBeTruthy();
  });

  it("warns visibly when the session has NO local protection", () => {
    durability.status = null;
    durability.pauseReason = null;
    durability.promotionState = null;
    durability.localProtection = "unavailable";

    renderBadge();

    const badge = screen.getByTestId("epic-durability-badge");
    expect(screen.getByText("No local backup")).toBeTruthy();
    expect(badge.getAttribute("data-local-protection")).toBe("unavailable");
  });

  it("treats an absent durability key from a @1.4 peer as unknown, not synced", () => {
    // The absence rule. `armed` would license the calm rendering; `unknown`
    // may not, and used to.
    durability.status = null;
    durability.pauseReason = null;
    durability.promotionState = null;
    durability.localProtection = "unknown";

    renderBadge();

    expect(screen.getByText("Storage status unknown")).toBeTruthy();
  });

  it("stays silent when both legs positively say cloud-durable and armed", () => {
    // The calm case still has to be silent, or the fix is just noise on every
    // healthy online epic. It is licensed by the explicit `"cloud"` member the
    // `@1.4` enum now carries - never by the absence of the key, which is the
    // inference the previous fixture encoded and the minor exists to break.
    durability.status = "cloud";
    durability.pauseReason = null;
    durability.promotionState = null;
    durability.localProtection = "armed";

    renderBadge();

    expect(screen.queryByTestId("epic-durability-badge")).toBeNull();
  });

  it("stays silent for a pre-@1.4 peer with no durability answer", () => {
    // Old hosts keep exactly their current rendering; the minor is additive.
    // The peer is identified by its NEGOTIATED version, not by the absence of
    // the key - see the next case for why those are not the same test.
    durability.status = null;
    durability.pauseReason = null;
    durability.promotionState = null;
    durability.localProtection = null;
    durability.peerSpeaksDurabilityLegs = false;

    renderBadge();

    expect(screen.queryByTestId("epic-durability-badge")).toBeNull();
  });

  it("treats an OMITTED localProtection from a @1.4 peer as unknown, not as an old peer", () => {
    // Every `@1.4` leg is optional on the wire and the schema's absence rule
    // says an omitted one means UNKNOWN. A presence probe cannot honour that:
    // it reads the permitted omission as "pre-@1.4" and falls back to the
    // silent rendering, which is silence-as-reassurance - the exact inference
    // this minor exists to break. Identical inputs to the case above except
    // for who is speaking.
    durability.status = null;
    durability.pauseReason = null;
    durability.promotionState = null;
    durability.localProtection = null;
    durability.peerSpeaksDurabilityLegs = true;

    renderBadge();

    expect(screen.getByText("Storage status unknown")).toBeTruthy();
  });

  it("shows the local-backup risk BESIDE a concrete status, not instead of it", () => {
    // `durability` and `localProtection` are separate axes. A frame carrying
    // both took the `stated` arm, which read only the status - so an offline
    // mirror with no WAL rendered as an ordinary "Cloud mirror - offline" and
    // the risk was invisible. Collapsing to `indeterminate` instead would have
    // dropped the status, and with it the paused-only remedies.
    durability.status = "offline";
    durability.pauseReason = null;
    durability.promotionState = null;
    durability.localProtection = "unavailable";

    renderBadge();

    expect(screen.getByText("Cloud mirror — offline")).toBeTruthy();
    expect(screen.getByTestId("epic-durability-risk").textContent).toContain(
      "No local backup",
    );
  });

  it("names the actionable delete-path pause reason instead of a bare paused", () => {
    // `s5-status-truthfulness` instance 2. All three delete reasons used to
    // fall through to "Sync paused"; this one means the epic holds local
    // edits the deleted cloud copy never received.
    durability.status = "paused";
    durability.pauseReason = "orphaned-local-edits-after-cloud-delete";
    durability.promotionState = null;
    durability.localProtection = "armed";

    renderBadge();

    expect(
      screen.getByText("Deleted in cloud — local edits kept here"),
    ).toBeTruthy();
    expect(screen.queryByText("Sync paused")).toBeNull();
  });
});

/**
 * The freshness half - `s5-mirror-first-serving`.
 *
 * Mirror-first serving paints a usable document before it is known to match
 * the cloud's, so these cases are all about the state the badge previously had
 * no way to reach: an epic that is FINE by every durability measure and is
 * still not what the cloud has.
 */
describe("<EpicDurabilityBadge /> - cloud freshness", () => {
  afterEach(() => {
    cleanup();
    durability.cloudFreshness = null;
  });

  /** The calm baseline every case below is measured against. */
  function cloudDurableAndArmed(): void {
    // The POSITIVE statement, not an absence - see the calm-case test above.
    durability.status = "cloud";
    durability.pauseReason = null;
    durability.promotionState = null;
    durability.localProtection = "armed";
  }

  it("stays silent for a cloud-durable epic whose document IS current", () => {
    cloudDurableAndArmed();
    durability.cloudFreshness = {
      kind: "lastCloudSyncAt",
      reconciledAtEpochMs: Date.now() - 30_000,
      state: "current",
    };

    const { container } = renderBadge();

    // `current` is the reassuring answer, and the badge draws only when there
    // is something to say. This is also the case that proves the freshness
    // half did not simply make the badge permanent.
    expect(container.firstChild).toBeNull();
  });

  it("stays silent when the host says NOTHING about freshness, so a pre-@1.4 peer is untouched", () => {
    cloudDurableAndArmed();
    durability.cloudFreshness = null;

    const { container } = renderBadge();

    expect(container.firstChild).toBeNull();
  });

  it("draws 'No local backup' over a cloud-durable epic whose protection is UNAVAILABLE", () => {
    // The axes are independent: cloud durability says where the work already
    // is, `unavailable` says offline edits die with the process. The calm
    // durability answer must not swallow the stated risk.
    cloudDurableAndArmed();
    durability.localProtection = "unavailable";

    renderBadge();

    const badge = screen.getByTestId("epic-durability-badge");
    expect(badge.getAttribute("data-local-protection")).toBe("unavailable");
    expect(badge.textContent).toContain("No local backup");
  });

  it("draws over a cloud-durable epic whose protection is UNKNOWN", () => {
    // `@1.5` defines `unknown` as "rendered as unknown, never as protected".
    // The calm return used to exclude only `unavailable`, so this case drew
    // nothing and was pixel-identical to `armed` - the calm answer on one axis
    // silently answering the other.
    cloudDurableAndArmed();
    durability.localProtection = "unknown";

    renderBadge();

    const badge = screen.getByTestId("epic-durability-badge");
    expect(badge.getAttribute("data-local-protection")).toBe("unknown");
    expect(badge.textContent).toContain("Local backup status unknown");
    // Names the protection axis, not the durability one: the host positively
    // said `"cloud"`, and casting doubt on that would be a second untruth.
    expect(badge.textContent).not.toContain("Storage status unknown");
  });

  it("draws the unknown protection beside a STATED local durability", () => {
    // The cloudDurable arm above was fixed first, and covering only that arm
    // left the more dangerous sibling: `durability: "local"` renders "Stored
    // locally", which tells the reader their work is on this disk, while
    // `unknown` says no WAL is known to hold it. Pixel-identical to `armed`
    // until this case existed.
    durability.status = "local";
    durability.pauseReason = null;
    durability.promotionState = null;
    durability.localProtection = "unknown";

    renderBadge();

    const badge = screen.getByTestId("epic-durability-badge");
    expect(badge.getAttribute("data-local-protection")).toBe("unknown");
    // Both axes, not one replacing the other - the status keeps its own
    // remedies and the protection doubt is stated beside it.
    expect(badge.textContent).toContain("Stored locally");
    expect(badge.textContent).toContain("Local backup status unknown");
  });

  it("colours an unknown protection as doubt, never as the loss treatment", () => {
    // `unavailable` is a stated fact about work that will be lost and earns
    // the destructive colour. An absence of a statement is not that, and
    // painting the two the same way trades one dishonesty for another.
    durability.status = "local";
    durability.pauseReason = null;
    durability.promotionState = null;
    durability.localProtection = "unknown";

    renderBadge();

    const badge = screen.getByTestId("epic-durability-badge");
    expect(badge.className).toContain("bg-amber-500/10");
    expect(badge.className).not.toContain("bg-destructive/10");
  });

  it("draws over a cloud-durable epic whose protection key a @1.5 peer OMITTED", () => {
    // Same case reached the other way: absence from a peer that speaks the
    // legs is the wire contract's `unknown`, so it must render identically.
    cloudDurableAndArmed();
    durability.localProtection = null;
    durability.peerSpeaksDurabilityLegs = true;

    renderBadge();

    expect(screen.getByTestId("epic-durability-badge").textContent).toContain(
      "Local backup status unknown",
    );
  });

  it("draws over a cloud-durable epic that is only a local copy, which the badge could not previously say", () => {
    cloudDurableAndArmed();
    durability.cloudFreshness = {
      kind: "lastCloudSyncAt",
      reconciledAtEpochMs: Date.now() - 5 * 60_000,
      state: "local-copy",
    };

    renderBadge();

    const badge = screen.getByTestId("epic-durability-badge");
    expect(badge.getAttribute("data-cloud-freshness")).toBe("local-copy");
    expect(screen.getByTestId("epic-cloud-freshness").textContent).toContain(
      "Local copy",
    );
    // The durability half genuinely has nothing to say here, and must not fill
    // the silence with the unknown copy - that would contradict the positive
    // `armed` the host sent alongside it.
    expect(screen.queryByText("Storage status unknown")).toBeNull();
  });

  it("says a stale mirror may be out of date, and shows the timestamp it persisted", () => {
    cloudDurableAndArmed();
    durability.cloudFreshness = {
      kind: "lastCloudSyncAt",
      // Three and a HALF days, not three. `useCompactRelativeTime` reads a
      // 60s-sampled clock captured at module load, so a timestamp sitting on a
      // bucket boundary rounds down whenever that sample lags `Date.now()` -
      // which is a flake, not a finding. Half a bucket of slack removes it
      // without weakening what is asserted.
      reconciledAtEpochMs: Date.now() - (3 * 24 + 12) * 60 * 60 * 1000,
      state: "stale",
    };

    renderBadge();

    expect(
      screen
        .getByTestId("epic-durability-badge")
        .getAttribute("data-cloud-freshness"),
    ).toBe("stale");
    expect(screen.getByTestId("epic-cloud-freshness").textContent).toContain(
      "may be out of date",
    );
    // The persisted stamp is what survives a restart of a CLOSED mirror, and
    // it is the difference between a worry and something a person can act on.
    expect(screen.getByTestId("epic-cloud-freshness-at").textContent).toContain(
      "3d",
    );
  });

  it("says NEVER SYNCED for a stale mirror with no recorded reconciliation, rather than leaving a blank", () => {
    cloudDurableAndArmed();
    // The `freshnessUnknown` arm. `current` is not even expressible on it, so
    // this is as reassuring as a mirror with no recorded reconciliation can
    // ever get.
    durability.cloudFreshness = { kind: "freshnessUnknown", state: "stale" };

    renderBadge();

    expect(screen.getByTestId("epic-cloud-freshness-at").textContent).toContain(
      "never synced",
    );
  });

  it("carries the freshness beside a stated durability instead of replacing it", () => {
    // The mirror-first paint itself: the host reports `offline` durability
    // (a LocalRoomConnection is serving) AND a stale document. Both are true
    // and they answer different questions, so the badge says both.
    durability.status = "offline";
    durability.pauseReason = null;
    durability.promotionState = null;
    durability.localProtection = "armed";
    durability.cloudFreshness = { kind: "freshnessUnknown", state: "syncing" };

    renderBadge();

    expect(screen.getByText("Cloud mirror — offline")).toBeTruthy();
    expect(screen.getByTestId("epic-cloud-freshness").textContent).toContain(
      "Checking for updates",
    );
  });
});
