import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  deriveEpicDurabilityPlane,
  type EpicDurabilityPlane,
} from "../epic-durability-plane";
import { EpicDurabilityRemedies } from "../epic-durability-remedies";
import {
  deriveEpicCloudFreshnessView,
  deriveEpicDurabilityView,
} from "@/lib/epic-selectors";
import type {
  EpicCloudFreshness,
  EpicDurabilityPauseReasonV15,
  EpicDurabilityStatusV15,
  EpicLocalProtection,
  EpicPromotionState,
} from "@traycer/protocol/host/epic/subscribe";

/**
 * Typed through the protocol union rather than an `as` assertion on the seed
 * value, matching the removed badge suite's own reasoning: a plain literal
 * would infer a narrow type that a later `null` reassignment cannot widen.
 */
const durability = vi.hoisted<{
  status: EpicDurabilityStatusV15 | null;
  pauseReason: EpicDurabilityPauseReasonV15 | null;
  promotionState: EpicPromotionState | null;
  protection: EpicLocalProtection | null;
  cloudFreshness: EpicCloudFreshness | null;
  peerSpeaksDurabilityLegs: boolean;
}>(() => ({
  status: "paused",
  pauseReason: "access-revoked",
  promotionState: null,
  protection: null,
  cloudFreshness: null,
  peerSpeaksDurabilityLegs: true,
}));

// The real derivations are forwarded unchanged - `deriveEpicDurabilityView`
// and `deriveEpicCloudFreshnessView` below call straight through to
// `importOriginal`'s implementation, both for the pure-function suite (which
// imports them directly) and for the two hooks `<EpicDurabilityRemedies />`
// reads. Stubbing either derivation would leave the class-level correction
// they encode untested while this file looked covered.
vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return {
    deriveEpicDurabilityView: actual.deriveEpicDurabilityView,
    useEpicDurabilityView: () =>
      actual.deriveEpicDurabilityView(
        durability.status,
        durability.protection,
        durability.peerSpeaksDurabilityLegs,
      ),
    useEpicDurabilityPauseReason: () => durability.pauseReason,
    useEpicDurabilityPromotionState: () => durability.promotionState,
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

/**
 * A configured platform origin, distinct from `resolvePlatformBaseUrl`'s
 * production fallback (`https://platform.traycer.ai`): without this, the
 * upgrade click would exercise `resolvePlatformBaseUrl(undefined)`'s fallback
 * arm and never prove the remedy reads a REAL `signInUrl` off the runner host.
 */
const CONFIGURED_SIGN_IN_URL = "https://auth.configured-shell.test/sign-in";

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    authnBaseUrl: "https://authn.test",
    signInUrl: CONFIGURED_SIGN_IN_URL,
    openExternalLink: vi.fn(),
  }),
}));

const openExternalLinkMutate = vi.hoisted(() => vi.fn());

// The remedy opens the upgrade link through this hook rather than the bridge
// directly (see the component's own comment), so this mock is what the click
// assertion below spies on instead of asserting on copy alone.
vi.mock("@/lib/links/open-link", () => ({
  useOpenLinkWithPending: () => ({
    openLink: openExternalLinkMutate,
    isPending: false,
  }),
}));

// ─── `deriveEpicDurabilityPlane` - the pure reading ────────────────────────

/** A fixed instant so every "synced Nd" clause in this file is deterministic. */
const NOW = Date.UTC(2026, 8, 5);

interface PlaneScenario {
  readonly status: EpicDurabilityStatusV15 | null;
  readonly protection: EpicLocalProtection | null;
  readonly peerSpeaksDurabilityLegs: boolean;
  readonly cloudFreshness: EpicCloudFreshness | null;
  readonly pauseReason: EpicDurabilityPauseReasonV15 | null;
  readonly promotionState: EpicPromotionState | null;
}

/**
 * Builds the plane through the REAL `deriveEpicDurabilityView` /
 * `deriveEpicCloudFreshnessView` (forwarded unchanged by the mock above),
 * exactly as `useEpicDurabilityPlane()` composes them.
 */
function planeFor(scenario: PlaneScenario): EpicDurabilityPlane | null {
  return deriveEpicDurabilityPlane({
    view: deriveEpicDurabilityView(
      scenario.status,
      scenario.protection,
      scenario.peerSpeaksDurabilityLegs,
    ),
    freshness: deriveEpicCloudFreshnessView(scenario.cloudFreshness),
    pauseReason: scenario.pauseReason,
    promotionState: scenario.promotionState,
    now: NOW,
  });
}

describe("deriveEpicDurabilityPlane", () => {
  it.each<EpicCloudFreshness | null>([
    null,
    {
      kind: "lastCloudSyncAt",
      reconciledAtEpochMs: NOW - 30_000,
      state: "current",
    },
  ])(
    "stays silent for a cloud-durable, armed epic with freshness %o",
    (cloudFreshness) => {
      expect(
        planeFor({
          status: "cloud",
          protection: "armed",
          peerSpeaksDurabilityLegs: true,
          cloudFreshness,
          pauseReason: null,
          promotionState: null,
        }),
      ).toBeNull();
    },
  );

  it("stays silent for a pre-@1.6 peer with no durability answer", () => {
    expect(
      planeFor({
        status: null,
        protection: null,
        peerSpeaksDurabilityLegs: false,
        cloudFreshness: null,
        pauseReason: null,
        promotionState: null,
      }),
    ).toBeNull();
  });

  it("reads an indeterminate durability as 'Storage status unknown'", () => {
    expect(
      planeFor({
        status: "unknown",
        protection: "unknown",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: null,
        pauseReason: null,
        promotionState: null,
      }),
    ).toEqual({ severity: "warning", sentence: "Storage status unknown" });
  });

  it("shows 'Recent changes only in this window' beside a stated status, not instead of it", () => {
    expect(
      planeFor({
        status: "offline",
        protection: "unavailable",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: null,
        pauseReason: null,
        promotionState: null,
      }),
    ).toEqual({
      severity: "danger",
      sentence: "Offline — sync paused · Recent changes only in this window",
    });
  });

  it("shows 'Recent changes only in this window' on an otherwise-calm cloud-durable epic", () => {
    expect(
      planeFor({
        status: "cloud",
        protection: "unavailable",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: null,
        pauseReason: null,
        promotionState: null,
      }),
    ).toEqual({
      severity: "danger",
      sentence: "Recent changes only in this window",
    });
  });

  it("reads unknown protection beside a stated local status as its own clause", () => {
    expect(
      planeFor({
        status: "local",
        protection: null,
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: null,
        pauseReason: null,
        promotionState: null,
      }),
    ).toEqual({
      severity: "warning",
      sentence: "Not synced yet · Backup status unknown",
    });
  });

  it("shows a visibly distinct 'Sync pending' for promotionState=pending", () => {
    expect(
      planeFor({
        status: "promoting",
        protection: "armed",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: null,
        pauseReason: null,
        promotionState: "pending",
      }),
    ).toEqual({ severity: "warning", sentence: "Sync pending" });
  });

  it("keeps the live 'Syncing' copy for promotionState=active", () => {
    expect(
      planeFor({
        status: "promoting",
        protection: "armed",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: null,
        pauseReason: null,
        promotionState: "active",
      }),
    ).toEqual({ severity: "activity", sentence: "Syncing" });
  });

  it("reads an offline mirror as a warning, not an error", () => {
    expect(
      planeFor({
        status: "offline",
        protection: "armed",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: null,
        pauseReason: null,
        promotionState: null,
      }),
    ).toEqual({ severity: "warning", sentence: "Offline — sync paused" });
  });

  it.each<[EpicDurabilityPauseReasonV15 | null, EpicDurabilityPlane]>([
    [
      "access-revoked",
      { severity: "danger", sentence: "Sync blocked — access revoked" },
    ],
    [
      "orphaned-local-edits-after-cloud-delete",
      {
        severity: "danger",
        sentence: "Deleted — unsynced edits kept",
      },
    ],
    [
      "delete-pending-acknowledgement",
      { severity: "steady", sentence: "Delete pending" },
    ],
    [
      "delete-tombstone-unscoped-cleared",
      { severity: "steady", sentence: "Delete recorded — tidying up" },
    ],
    ["entitlement-lapsed", { severity: "warning", sentence: "Sync paused" }],
    [null, { severity: "warning", sentence: "Sync paused" }],
  ])("reads pause reason %s as %o", (pauseReason, expected) => {
    expect(
      planeFor({
        status: "paused",
        protection: "armed",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: null,
        pauseReason,
        promotionState: null,
      }),
    ).toEqual(expected);
  });

  it("says a stale mirror may be out of date, with the persisted timestamp", () => {
    // Three and a HALF days, not three: `formatCompactRelativeTime` floors to
    // whole days, so a timestamp sitting on the 3-day boundary would round
    // down to "3d" only by coincidence. Half a bucket of slack removes that.
    const reconciledAtEpochMs = NOW - (3 * 24 + 12) * 60 * 60 * 1000;
    expect(
      planeFor({
        status: "cloud",
        protection: "armed",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: {
          kind: "lastCloudSyncAt",
          reconciledAtEpochMs,
          state: "stale",
        },
        pauseReason: null,
        promotionState: null,
      }),
    ).toEqual({
      severity: "warning",
      sentence: "Saved copy — may be out of date · synced 3d",
    });
  });

  it("says never synced for a stale mirror with no recorded reconciliation", () => {
    expect(
      planeFor({
        status: "cloud",
        protection: "armed",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: { kind: "freshnessUnknown", state: "stale" },
        pauseReason: null,
        promotionState: null,
      }),
    ).toEqual({
      severity: "warning",
      sentence: "Saved copy — may be out of date · never synced",
    });
  });

  it("reads a local-copy freshness as a calm 'Saved copy'", () => {
    expect(
      planeFor({
        status: "cloud",
        protection: "armed",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: { kind: "freshnessUnknown", state: "local-copy" },
        pauseReason: null,
        promotionState: null,
      }),
    ).toEqual({ severity: "steady", sentence: "Saved copy" });
  });

  it("reads a syncing freshness as 'Checking for updates'", () => {
    expect(
      planeFor({
        status: "cloud",
        protection: "armed",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: { kind: "freshnessUnknown", state: "syncing" },
        pauseReason: null,
        promotionState: null,
      }),
    ).toEqual({ severity: "activity", sentence: "Checking for updates" });
  });

  it("takes the strongest clause's severity, in status · risk · freshness order", () => {
    expect(
      planeFor({
        status: "local",
        protection: "unavailable",
        peerSpeaksDurabilityLegs: true,
        cloudFreshness: { kind: "freshnessUnknown", state: "stale" },
        pauseReason: null,
        promotionState: null,
      }),
    ).toEqual({
      severity: "danger",
      sentence:
        "Not synced yet · Recent changes only in this window · Saved copy — may be out of date · never synced",
    });
  });

  // `s5-vocabulary-cleanup`: every clause used to name which SIDE of the sync
  // a fact came from ("cloud", "local", "this device") instead of naming the
  // condition as the person experiences it. This matrix sweeps the arms that
  // used to say so and pins that none of them do any more.
  it("never says cloud, local or device in any clause", () => {
    interface MatrixCase {
      readonly name: string;
      readonly scenario: PlaneScenario;
    }

    const pauseReasons: ReadonlyArray<EpicDurabilityPauseReasonV15 | null> = [
      "access-revoked",
      "orphaned-local-edits-after-cloud-delete",
      "delete-pending-acknowledgement",
      "delete-tombstone-unscoped-cleared",
      "entitlement-lapsed",
      null,
    ];

    const cases: ReadonlyArray<MatrixCase> = [
      {
        name: "stated local, protection armed",
        scenario: {
          status: "local",
          protection: "armed",
          peerSpeaksDurabilityLegs: true,
          cloudFreshness: null,
          pauseReason: null,
          promotionState: null,
        },
      },
      {
        name: "stated promoting, promotionState active",
        scenario: {
          status: "promoting",
          protection: "armed",
          peerSpeaksDurabilityLegs: true,
          cloudFreshness: null,
          pauseReason: null,
          promotionState: "active",
        },
      },
      {
        name: "stated promoting, promotionState pending",
        scenario: {
          status: "promoting",
          protection: "armed",
          peerSpeaksDurabilityLegs: true,
          cloudFreshness: null,
          pauseReason: null,
          promotionState: "pending",
        },
      },
      {
        name: "stated offline, protection unavailable, freshness stale with a reconciledAt",
        scenario: {
          status: "offline",
          protection: "unavailable",
          peerSpeaksDurabilityLegs: true,
          cloudFreshness: {
            kind: "lastCloudSyncAt",
            reconciledAtEpochMs: NOW - 60_000,
            state: "stale",
          },
          pauseReason: null,
          promotionState: null,
        },
      },
      ...pauseReasons.map((pauseReason) => ({
        name: `paused, pauseReason ${String(pauseReason)}`,
        scenario: {
          status: "paused",
          protection: "armed",
          peerSpeaksDurabilityLegs: true,
          cloudFreshness: null,
          pauseReason,
          promotionState: null,
        } satisfies PlaneScenario,
      })),
      {
        name: "cloudDurable, protection unknown",
        scenario: {
          status: "cloud",
          protection: "unknown",
          peerSpeaksDurabilityLegs: true,
          cloudFreshness: null,
          pauseReason: null,
          promotionState: null,
        },
      },
      {
        name: "indeterminate, protection unavailable",
        scenario: {
          status: "unknown",
          protection: "unavailable",
          peerSpeaksDurabilityLegs: true,
          cloudFreshness: null,
          pauseReason: null,
          promotionState: null,
        },
      },
      {
        name: "freshness local-copy",
        scenario: {
          status: "cloud",
          protection: "armed",
          peerSpeaksDurabilityLegs: true,
          cloudFreshness: { kind: "freshnessUnknown", state: "local-copy" },
          pauseReason: null,
          promotionState: null,
        },
      },
    ];

    for (const { name, scenario } of cases) {
      const plane = planeFor(scenario);
      if (plane === null) continue;
      expect(plane.sentence, name).not.toMatch(/\bcloud\b/i);
      expect(plane.sentence, name).not.toMatch(/\blocal(ly)?\b/i);
      expect(plane.sentence, name).not.toMatch(/device/i);
    }
  });
});

// ─── `<EpicDurabilityRemedies />` - the paused-only actions ────────────────

function renderRemedies(): RenderResult {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <EpicDurabilityRemedies />
    </QueryClientProvider>,
  );
}

/**
 * `durability` is one hoisted object shared by every test in this describe
 * block, so every field is reseeded before each test rather than relying on
 * an ordering dependency between them.
 */
function resetDurabilityFixture(): void {
  durability.status = "paused";
  durability.pauseReason = "access-revoked";
  durability.promotionState = null;
  durability.protection = null;
  durability.cloudFreshness = null;
  durability.peerSpeaksDurabilityLegs = true;
}

describe("<EpicDurabilityRemedies />", () => {
  beforeEach(resetDurabilityFixture);
  afterEach(() => {
    cleanup();
    openExternalLinkMutate.mockClear();
  });

  it("shows the export remedy, disabled with zero artifacts, for access-revoked", () => {
    durability.status = "paused";
    durability.pauseReason = "access-revoked";

    renderRemedies();

    const exportButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Export artifacts",
    });
    expect(exportButton.disabled).toBe(true);
    expect(screen.queryByText("Upgrade")).toBeNull();
  });

  it("shows the export remedy, disabled with zero artifacts, for the preserved orphan", () => {
    durability.status = "paused";
    durability.pauseReason = "orphaned-local-edits-after-cloud-delete";

    renderRemedies();

    const exportButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Export artifacts",
    });
    expect(exportButton.disabled).toBe(true);
    expect(screen.queryByText("Upgrade")).toBeNull();
  });

  it("shows upgrade only for the entitlement-lapsed reason, with no export remedy", () => {
    durability.status = "paused";
    durability.pauseReason = "entitlement-lapsed";

    renderRemedies();

    expect(screen.getByText("Upgrade")).toBeTruthy();
    expect(screen.queryByText("Export artifacts")).toBeNull();
  });

  it("opens the upgrade link at the runner host's configured platform origin", () => {
    durability.status = "paused";
    durability.pauseReason = "entitlement-lapsed";

    renderRemedies();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    expect(openExternalLinkMutate).toHaveBeenCalledWith(
      new URL(CONFIGURED_SIGN_IN_URL).origin,
      "auth",
      null,
    );
  });

  it("renders nothing for an omitted pause reason", () => {
    durability.status = "paused";
    durability.pauseReason = null;

    renderRemedies();

    expect(screen.queryByText("Upgrade")).toBeNull();
    expect(screen.queryByText("Export artifacts")).toBeNull();
  });

  it.each<EpicDurabilityStatusV15>(["local", "offline", "promoting"])(
    "renders nothing for the non-paused status %s",
    (status) => {
      durability.status = status;
      durability.pauseReason = null;

      renderRemedies();

      expect(screen.queryByText("Upgrade")).toBeNull();
      expect(screen.queryByText("Export artifacts")).toBeNull();
    },
  );

  it.each<EpicDurabilityPauseReasonV15>([
    "delete-pending-acknowledgement",
    "delete-tombstone-unscoped-cleared",
  ])("renders nothing for the delete-bookkeeping reason %s", (pauseReason) => {
    durability.status = "paused";
    durability.pauseReason = pauseReason;

    renderRemedies();

    expect(screen.queryByText("Upgrade")).toBeNull();
    expect(screen.queryByText("Export artifacts")).toBeNull();
  });
});
