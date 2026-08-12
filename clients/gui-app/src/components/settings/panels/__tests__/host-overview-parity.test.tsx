// The Overview's whole premise: local and remote render from the SAME
// components reading the SAME RPCs. Mocked at the scope/binding boundary the
// same way `shell-settings-panel.test.tsx` does — these suites render the
// panel bare, without the host runtime and query providers the real
// `useHostScope` needs.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

const hostBindingMock = vi.hoisted(
  (): { current: { readonly hostClient: unknown } | null } => ({
    current: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { buildOverviewHostFixture } from "@/components/settings/panels/__tests__/host-overview-test-support";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

/**
 * The account-backed registry item, so BOTH variants render the whole page —
 * including the account-backed half that `item: null` used to hide from this
 * comparison entirely. Same value for both variants except `hostId`, which
 * `registryItemFor` stamps in: `HostRegistryUpdates` keys several of its own
 * testids by it (`host-auto-update-${hostId}`, …), and normalizing that back
 * out is `normalizeTestId`'s job below, not this fixture's.
 */
function registryItemFor(hostId: string): HostListItem {
  return {
    hostId,
    displayName: "Studio Mac",
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    status: {
      presenceLease: "fresh",
      hostRelayAttached: true,
      viewerReachability: "unknown",
      clientCloud: "ok",
      busy: false,
      busySessionCount: 0,
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  };
}

interface OverviewSemanticSnapshot {
  /** Every `data-testid` under the panel root, sorted — the real "same
   *  surface" assertion: two pages that render the same set of rows and
   *  controls agree on this even if nothing else were checked. */
  readonly testIds: readonly string[];
  /** The accessible name of every rendered `button`, sorted. */
  readonly buttonNames: readonly string[];
  /** Every section/group heading's text, sorted. */
  readonly headingTexts: readonly string[];
  readonly displayedName: string;
  readonly endpointText: string | null;
  readonly thisComputerTagPresent: boolean;
  readonly recoveryConsolePresent: boolean;
  /**
   * The danger-zone removal controls the surface comparison filters out.
   *
   * Captured rather than merely excluded, because "excluded" and "unasserted"
   * are not the same thing and the difference is where a regression hides: with
   * these only filtered, deleting the remote row entirely would leave both
   * variants agreeing on its absence and this suite green. The endpoint text
   * gets the same treatment one field up, for the same reason.
   */
  readonly removalTestIds: readonly string[];
  /**
   * ORDINARY BODY TEXT — the panel's whole rendered text, with the three named
   * differences deleted from it.
   *
   * The structural fields above (testids, button names, headings) miss exactly
   * one class of divergence: prose. A review found a fourth, unlisted visual
   * difference hiding in precisely that gap — `HostRegistryUpdates` forked its
   * auto-update sentence on `isLocalHost`, so the same fixtures produced
   * different Updates explanations for local and remote while every structural
   * field stayed equal and this suite stayed green.
   *
   * Deleting (rather than masking) the known-different fragments is what makes
   * the remainder directly comparable: a placeholder would itself differ,
   * because one side never had the fragment at all.
   *
   * Only the REMOVAL ROW is dropped out of the danger zone — not the zone. An
   * earlier version discarded the whole subtree, which took the SHARED
   * File-edit-snapshots row's prose with it and left a future `isLocalMachine`
   * fork there invisible: the same blind spot, one card over. The removal row
   * alone is the settled local/remote exception (its presence is still compared
   * via `removalTestIds` above, and the zone's behaviour is covered end-to-end
   * by `host-danger-zone.test.tsx`); everything else — identity card, Updates,
   * Installation, and the shared danger-zone row — is compared verbatim.
   */
  readonly bodyTextWithoutLocalOnlyDifferences: string;
}

/**
 * The scope row's `name` — the registry `displayName` — deliberately DIFFERENT
 * from the identity RPC's `effectiveName`, and deliberately the SAME for both
 * variants.
 *
 * Different from `effectiveName` is the pin: the page must render what the host
 * says it is called, so a fallback to this string fails `findByText` outright.
 *
 * Same across variants is what lets the prose comparison run without a
 * normalization. A review asked for the previous per-variant names' masking
 * `.split(rowName)` to be dropped on the grounds that `rowName` had no
 * legitimate occurrence left in the compared prose. That premise is wrong —
 * `host-settings-panel.tsx` renders it in the panel description ("Status,
 * updates and maintenance for …"), which is shared prose and squarely inside
 * the comparison. Adding a second exclusion for that description would have
 * re-opened the same blind spot one line lower. Sharing one name removes the
 * need for any masking at all, and the stale-name fallback stays caught.
 */
const SHARED_ROW_NAME = "stale-registry-label";

/**
 * The local-only differences this snapshot is EXPECTED to carry, named so a
 * failure elsewhere in the snapshot cannot hide behind "well, something has
 * to differ". Each entry says why it is legitimate, and the test asserts
 * every one of them explicitly instead of just excluding it.
 */
const LOCAL_ONLY_SNAPSHOT_DIFFERENCES = [
  // The endpoint testid (`host-overview-endpoint`) is present in BOTH — only
  // its text differs: local shows `ws://… · pid N`, remote shows
  // `via <relay origin> · …`. Excluding the testid itself would hide a
  // regression where the row vanishes for one variant; only the text is
  // legitimately different.
  "endpointText",
  // Only `host.isLocalMachine` gets the "This computer" tag next to its name.
  "thisComputerTagPresent",
  // The danger zone's removal row sits on a third capability plane the page was
  // never meant to unify: "Remove Traycer" uninstalls components from THIS
  // computer over the CLI bridge, "Remove from account" ends registry
  // membership and touches nothing on the machine. They are, in that file's own
  // words, "not two versions of one action". Asserted below per variant.
  "removalTestIds",
] as const satisfies readonly (keyof OverviewSemanticSnapshot)[];

type SnapshotWithoutLocalOnlyDifferences = Omit<
  OverviewSemanticSnapshot,
  (typeof LOCAL_ONLY_SNAPSHOT_DIFFERENCES)[number]
>;

function omitLocalOnlyDifferences(
  snapshot: OverviewSemanticSnapshot,
): SnapshotWithoutLocalOnlyDifferences {
  const excluded: readonly string[] = LOCAL_ONLY_SNAPSHOT_DIFFERENCES;
  const kept = Object.entries(snapshot).filter(
    ([key]) => !excluded.includes(key),
  );
  return Object.fromEntries(kept) as SnapshotWithoutLocalOnlyDifferences;
}

/** `data-testid` values that embed the host's own id normalize to one token,
 * so `host-auto-update-host-local` and `host-auto-update-host-remote` — the
 * SAME row, differently keyed — compare equal. Anything that differs for a
 * reason OTHER than the host id stays different and fails the test, which is
 * the point. */
function normalizeTestId(testId: string, hostId: string): string {
  return testId.split(hostId).join("<HOST_ID>");
}

/**
 * The Danger Zone's REMOVAL verb, filtered out by name rather than folded
 * into a broader "ignore the danger zone" carve-out.
 *
 * `HostDangerZone`'s own comments settle this: "Remove Traycer" uninstalls
 * components from THIS computer over the CLI bridge; "Remove from account"
 * ends registry membership and touches nothing on the machine. They are "not
 * two versions of one action" — a local host with no CLI bridge (this
 * fixture's `MockRunnerHost` carries none) gets NEITHER control, and a
 * registered remote host gets the account one. That is not the Overview
 * restructure's "one page, same components" claim failing; it is a third
 * capability plane the page was never meant to unify. The snapshots row this
 * suite DOES share — clear file-edit snapshots, its size read — stays in the
 * comparison, so a real regression there still fails the test.
 */
const DANGER_ZONE_REMOVAL_TEST_IDS: ReadonlySet<string> = new Set([
  "settings-remove-traycer",
  "settings-remove-traycer-spinner",
  "settings-quit-after-uninstall",
  "settings-remove-host-from-account",
  "settings-remove-host-from-account-spinner",
]);
const DANGER_ZONE_REMOVAL_BUTTON_NAMES: ReadonlySet<string> = new Set([
  "Remove Traycer",
  "Quit Traycer",
  "Remove from account",
]);

function accessibleButtonName(button: Element): string {
  const ariaLabel = button.getAttribute("aria-label");
  if (ariaLabel !== null && ariaLabel.length > 0) return ariaLabel;
  return button.textContent.replace(/\s+/g, " ").trim();
}

/**
 * Renders one variant (local or remote) against a caller-supplied fixture and
 * reduces the DOM to a complete structural snapshot. Never a raw text diff:
 * the endpoint line and the "This computer" tag legitimately differ between
 * the two variants, and a whole-tree diff would fail on those instead of
 * proving the page itself is identical.
 */
async function renderOverviewSnapshot(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly effectiveName: string;
  readonly rowName: string;
  /** Different from the scope row's `version` (which defaults to `1.4.2`) so
   *  a card that ever fell back to the row's stale version instead of the
   *  RPC's current one would visibly show the wrong number. */
  readonly hostVersion: string;
}): Promise<OverviewSemanticSnapshot> {
  const fixture = buildOverviewHostFixture({
    hostId: options.hostId,
    isLocalMachine: options.isLocalMachine,
    effectiveName: options.effectiveName,
    hostVersion: options.hostVersion,
  });

  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: options.hostId,
      isLocalMachine: options.isLocalMachine,
      connectable: true,
      // Deliberately DIFFERENT from `effectiveName`: if the page ever reads the
      // scope row's name instead of `host.identity.get`'s answer, this pins
      // that regression by making the wrong source visibly wrong.
      name: options.rowName,
      item: registryItemFor(options.hostId),
      entry: options.isLocalMachine
        ? null
        : {
            hostId: options.hostId,
            label: options.hostId,
            kind: "remote",
            websocketUrl: "wss://relay.traycer.ai/rpc/abc123",
            version: "1.5.0",
            status: "available",
          },
    }),
    hostId: options.hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = { hostClient: fixture.client };

  const runnerHost: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: options.isLocalMachine
      ? {
          hostId: options.hostId,
          websocketUrl: "ws://127.0.0.1:8765",
          version: "1.5.0",
          pid: 4821,
          systemHostName: options.hostId,
          displayName: options.hostId,
        }
      : null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );

  const displayedName = (await screen.findByText(options.effectiveName))
    .textContent;

  const testIds = Array.from(view.container.querySelectorAll("[data-testid]"))
    .map((node) => node.getAttribute("data-testid") ?? "")
    .filter((testId) => !DANGER_ZONE_REMOVAL_TEST_IDS.has(testId))
    .map((testId) => normalizeTestId(testId, options.hostId))
    .sort();

  const endpointText =
    screen.queryByTestId("host-overview-endpoint")?.textContent ?? null;
  const removalTestIds = Array.from(
    view.container.querySelectorAll("[data-testid]"),
  )
    .map((node) => node.getAttribute("data-testid") ?? "")
    .filter((testId) => DANGER_ZONE_REMOVAL_TEST_IDS.has(testId))
    .sort();

  // REACH OF THIS COMPARISON: the rendered panel subtree only. Radix renders
  // dialogs through a portal, outside `view.container`, so no confirmation copy
  // is visible here — dialog copy is pinned directly in the suite that owns the
  // dialog (`host-danger-zone.test.tsx` for both danger-zone confirmations).
  // Don't extend this machinery to portals; add the direct pin instead.
  //
  // Node-exact subtraction, never global string deletion.
  //
  // An earlier version lifted out the WHOLE danger-zone subtree and deleted the
  // endpoint/tag text as strings. Both were too blunt, in the precise class of
  // blind spot this comparison exists to close: the danger zone has one SHARED
  // RPC-backed row (File edit snapshots) whose prose must match, so discarding
  // the subtree would let a future `isLocalMachine` fork there stay green; and
  // deleting "This computer" as a string would also erase those words from any
  // real fork that happened to contain them. Removing the exact nodes leaves
  // everything else — including the shared danger-zone row — compared verbatim.
  const bodyRoot = view.container.cloneNode(true);
  if (!(bodyRoot instanceof HTMLElement)) {
    throw new Error("expected an element clone for the body-text comparison");
  }
  for (const node of localOnlyNodes(bodyRoot)) node.remove();
  const bodyTextWithoutLocalOnlyDifferences = bodyRoot.textContent
    // The Host ID row renders the id on purpose, and the two variants must have
    // different ids to be two hosts at all. This is the ONE fixture artifact
    // normalized here; the scope row's `name` deliberately is NOT — see
    // `SHARED_ROW_NAME`.
    .split(options.hostId)
    .join("<HOST_ID>")
    .replace(/\s+/gu, " ")
    .trim();

  const buttonNames = within(view.container)
    .getAllByRole("button")
    .map(accessibleButtonName)
    .filter((name) => !DANGER_ZONE_REMOVAL_BUTTON_NAMES.has(name))
    .sort();

  const headingTexts = within(view.container)
    .getAllByRole("heading")
    .map((heading) => heading.textContent.trim())
    .sort();

  return {
    testIds,
    buttonNames,
    headingTexts,
    displayedName,
    endpointText,
    thisComputerTagPresent: screen.queryByText("This computer") !== null,
    recoveryConsolePresent:
      screen.queryByTestId("settings-host-identity") !== null,
    removalTestIds,
    bodyTextWithoutLocalOnlyDifferences,
  };
}

describe("<HostSettingsPanel /> Overview local/remote parity", () => {
  it("renders the identical Overview surface for a local and a remote host reading the same RPC fixtures", async () => {
    const local = await renderOverviewSnapshot({
      hostId: "host-local",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
      rowName: SHARED_ROW_NAME,
      hostVersion: "1.5.0",
    });
    cleanup();
    const remote = await renderOverviewSnapshot({
      hostId: "host-remote",
      isLocalMachine: false,
      effectiveName: "Studio Mac",
      rowName: SHARED_ROW_NAME,
      hostVersion: "1.5.0",
    });

    // The whole surface — every testid, every button, every heading — is the
    // SAME between the two variants once the two settled, named, local-only
    // differences are set aside. Anything else that differs fails here.
    expect(omitLocalOnlyDifferences(remote)).toEqual(
      omitLocalOnlyDifferences(local),
    );

    // The name came from `host.identity.get`'s `effectiveName` in BOTH cases —
    // not the scope row's `name`, which was deliberately different.
    expect(local.displayedName).toBe("Studio Mac");
    expect(remote.displayedName).toBe("Studio Mac");
  });

  it("differs ONLY on the endpoint text and the 'This computer' tag — both named, both asserted", async () => {
    const local = await renderOverviewSnapshot({
      hostId: "host-local",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
      rowName: SHARED_ROW_NAME,
      hostVersion: "1.5.0",
    });
    cleanup();
    const remote = await renderOverviewSnapshot({
      hostId: "host-remote",
      isLocalMachine: false,
      effectiveName: "Studio Mac",
      rowName: SHARED_ROW_NAME,
      hostVersion: "1.5.0",
    });

    expect(local.endpointText).not.toBeNull();
    expect(local.endpointText).toContain("ws://127.0.0.1");
    expect(local.endpointText).toContain("pid 4821");
    expect(local.endpointText).not.toContain("via ");

    expect(remote.endpointText).not.toBeNull();
    expect(remote.endpointText).toContain("via ");
    expect(remote.endpointText).not.toContain("ws://");
    expect(remote.endpointText).not.toContain("pid ");

    expect(local.thisComputerTagPresent).toBe(true);
    expect(remote.thisComputerTagPresent).toBe(false);

    // The recovery console is absent in both — not a local/remote difference
    // at all, so it stays inside the main equality check too; asserted here
    // explicitly as well since it is exactly the surface this restructure
    // moved off the page.
    expect(local.recoveryConsolePresent).toBe(false);
    expect(remote.recoveryConsolePresent).toBe(false);

    // The third named difference, asserted rather than just filtered.
    //
    // A registered remote host gets the account-removal control. The local
    // variant gets NEITHER control here — not because local hosts have none,
    // but because this fixture's `MockRunnerHost` carries no CLI bridge and
    // `RemoveTraycerRow` renders nothing without one. Both halves are stated so
    // that deleting the remote row, or growing a local one that should not
    // exist without a bridge, fails here instead of passing as "they agree".
    expect(remote.removalTestIds).toEqual([
      "settings-remove-host-from-account",
    ]);
    expect(local.removalTestIds).toEqual([]);
  });

  it("shows the RPC's hostVersion on the identity line, and NEVER the stale registry row version", async () => {
    // The reviewer's actual finding: both a `host.status.hostVersion` and the
    // registry row's `version` used to render on one card at once. The row
    // fixture defaults `version` to "1.4.2" (`hostScopeOptionFixture`); this
    // pins the RPC's "1.5.0" as the ONLY version shown, for both variants.
    const local = await renderOverviewSnapshot({
      hostId: "host-local",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
      rowName: SHARED_ROW_NAME,
      hostVersion: "1.5.0",
    });
    const localCard = screen.getByTestId("host-identity-card");
    expect(localCard.textContent).toContain("v1.5.0");
    expect(localCard.textContent).not.toContain("1.4.2");
    cleanup();

    const remote = await renderOverviewSnapshot({
      hostId: "host-remote",
      isLocalMachine: false,
      effectiveName: "Studio Mac",
      rowName: SHARED_ROW_NAME,
      hostVersion: "1.5.0",
    });
    const remoteCard = screen.getByTestId("host-identity-card");
    expect(remoteCard.textContent).toContain("v1.5.0");
    expect(remoteCard.textContent).not.toContain("1.4.2");

    // Belt and braces on the fixture itself: if this ever reads "1.5.0" back
    // from the row instead of the RPC, the whole pin above is vacuous.
    expect(local.displayedName).toBe("Studio Mac");
    expect(remote.displayedName).toBe("Studio Mac");
  });
});

/**
 * The exact DOM nodes that legitimately differ between the two variants.
 *
 * Returned as nodes rather than strings so the caller deletes precisely them —
 * a string deletion would also strip the same words wherever else they appear,
 * which is how a genuine copy fork could hide inside its own exclusion.
 */
function localOnlyNodes(root: HTMLElement): readonly Element[] {
  const nodes: Element[] = [];
  const endpoint = root.querySelector('[data-testid="host-overview-endpoint"]');
  if (endpoint !== null) nodes.push(endpoint);

  // The "This computer" tag, located by WHERE IT LIVES — not by its text.
  //
  // Matching every leaf span in the panel with that exact text removed a
  // genuine local-only fork rendering `<span>This computer</span>` elsewhere
  // along with the settled tag — the exclusion swallowing the class of
  // difference it exists to expose.
  //
  // That was never observable while the broad matcher shipped, and the reason
  // is worth recording precisely, because it is not a reason anyone should rely
  // on: `thisComputerTagPresent` below reads `screen.queryByText(...)`, and
  // Testing Library's SINGULAR query throws on multiple matches, so a second
  // same-text node blew the test up before any exclusion mattered. The safety
  // was incidental to another field's failure mode, one refactor deep — swap
  // that presence check to the natural `queryAllByText(...).length > 0` and the
  // broad matcher lets a real on-screen fork pass green. (Verified both ways:
  // broad + that refactor passes 3/3 with the fork rendering; scoped + the same
  // refactor fails.)
  //
  // So: look only inside the identity card's heading row, where the settled tag
  // sits beside the host name, and require EXACTLY ONE. A duplicate there fails
  // loudly; a same-text span anywhere else stays in the compared prose and
  // breaks equality on its own — neither outcome borrowed from another field.
  const identityHeadingRow =
    root.querySelector('[data-testid="host-identity-card"] h2')
      ?.parentElement ?? null;
  const settledTags =
    identityHeadingRow === null
      ? []
      : Array.from(identityHeadingRow.children).filter(
          (child) =>
            child.tagName === "SPAN" &&
            child.children.length === 0 &&
            child.textContent.trim() === "This computer",
        );
  if (settledTags.length > 1) {
    throw new Error(
      `expected at most one "This computer" tag in the identity card, found ${settledTags.length}`,
    );
  }
  nodes.push(...settledTags);

  // Only the REMOVAL row is the settled danger-zone exception. Located by
  // walking from its control up to the row that is a direct child of the
  // group's content wrapper, so the shared snapshots row beside it stays in the
  // compared prose.
  const group = root.querySelector('[data-testid="host-danger-zone"]');
  const content = group?.querySelector(":scope > div") ?? null;
  if (content !== null) {
    for (const testId of DANGER_ZONE_REMOVAL_TEST_IDS) {
      const control = content.querySelector(`[data-testid="${testId}"]`);
      if (control === null) continue;
      let row: Element = control;
      while (row.parentElement !== null && row.parentElement !== content) {
        row = row.parentElement;
      }
      if (row.parentElement === content) nodes.push(row);
    }
  }
  return nodes;
}
