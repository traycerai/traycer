// The Overview re-provides a scoped stream binding beside its unary one (for the Data & migration group), and
// the real hook reads `useAuthService` - which this suite deliberately does not stand up.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

// Mocked at the scope/binding boundary the same way `shell-settings-panel.test.tsx` does - these suites render
// the panel bare, without the host runtime and query providers the real `useHostScope` needs.
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

/** Same value for both variants except `hostId`, which `registryItemFor` stamps in: `HostRegistryUpdates` keys
 * several of its own testids by it (`host-auto-update-${hostId}`, …). */
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
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  };
}

interface OverviewSemanticSnapshot {
  /** Every `data-testid` under the panel root, sorted - the real "same surface" assertion: two pages that render
   * the same set of rows and controls agree on this even if nothing else were checked. */
  readonly testIds: readonly string[];
  readonly buttonNames: readonly string[];
  readonly headingTexts: readonly string[];
  readonly displayedName: string;
  /** The kind tag's text - "Local" or "Remote" - rather than whether a tag is there at all. */
  readonly kindTagLabel: string | null;
  readonly recoveryConsolePresent: boolean;
  /** Captured rather than merely excluded, because "excluded" and "unasserted" are not the same thing and the
   * difference is where a regression hides. */
  readonly removalTestIds: readonly string[];
  /** Deleting (rather than masking) the known-different fragments is what makes the remainder directly
   * comparable: a placeholder would itself differ, because one side never had the fragment at all. */
  readonly bodyTextWithoutLocalOnlyDifferences: string;
}

/** Different from `effectiveName` is the pin: the page must render what the host says it is called, so a
 * fallback to this string fails `findByText` outright. */
const SHARED_ROW_NAME = "stale-registry-label";

/** The local-only differences this snapshot is expected to carry, named so a failure elsewhere in the snapshot
 * cannot hide behind "well, something has to differ". */
const LOCAL_ONLY_SNAPSHOT_DIFFERENCES = [
  // The kind tag beside the name reads "Local" on one and "Remote" on the other. One tag, one slot, one word
  // different - asserted verbatim below.
  "kindTagLabel",
  // The danger zone's removal row sits on a third capability plane the page was never meant to unify.
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

/** `data-testid` values that embed the host's own id normalize to one token, so `host-auto-update-host-local`
 * and `host-auto-update-host-remote` - the same row, differently keyed - compare equal. */
function normalizeTestId(testId: string, hostId: string): string {
  return testId.split(hostId).join("<HOST_ID>");
}

/** That is not the Overview restructure's "one page, same components" claim failing; it is a third capability
 * plane the page was never meant to unify. */
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

/** Never a raw text diff: the "This computer" tag legitimately differs between the two variants, and a
 * whole-tree diff would fail on it instead of proving the page itself is identical. */
async function renderOverviewSnapshot(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly effectiveName: string;
  readonly rowName: string;
  /** Different from the scope row's `version` (which defaults to `1.4.2`) so a card that ever fell back to the
   * row's stale version instead of the RPC's current one would visibly show the wrong number. */
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
      // Deliberately different from `effectiveName`: if the page ever reads the scope row's name instead of
      // `host.identity.get`'s answer, this pins that regression by making the wrong source visibly wrong.
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
            transportDialability: "dialable",
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
          availability: "available" as const,
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

  const removalTestIds = Array.from(
    view.container.querySelectorAll("[data-testid]"),
  )
    .map((node) => node.getAttribute("data-testid") ?? "")
    .filter((testId) => DANGER_ZONE_REMOVAL_TEST_IDS.has(testId))
    .sort();

  // Don't extend this machinery to portals; add the direct pin instead. Node-exact subtraction, never global
  // string deletion.
  const bodyRoot = view.container.cloneNode(true);
  if (!(bodyRoot instanceof HTMLElement)) {
    throw new Error("expected an element clone for the body-text comparison");
  }
  for (const node of localOnlyNodes(bodyRoot)) node.remove();
  const bodyTextWithoutLocalOnlyDifferences = bodyRoot.textContent
    // The Host ID row renders the id on purpose, and the two variants must have different ids to be two hosts at
    // all.
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
    kindTagLabel: readKindTagLabel(view.container),
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

    // The whole surface - every testid, every button, every heading - is the same between the two variants once
    // the two settled, named, local-only differences are set aside.
    expect(omitLocalOnlyDifferences(remote)).toEqual(
      omitLocalOnlyDifferences(local),
    );

    // The name came from `host.identity.get`'s `effectiveName` in both cases - not the scope row's `name`, which
    // was deliberately different.
    expect(local.displayedName).toBe("Studio Mac");
    expect(remote.displayedName).toBe("Studio Mac");
  });

  it("differs ONLY on the kind tag's word — Local vs Remote, named and asserted", async () => {
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

    // A reader who remembers `ws://… · pid N` would otherwise assume it moved rather than went, and the local
    // variant is still rendered against a snapshot that has a loopback URL and a pid.
    expect(local.bodyTextWithoutLocalOnlyDifferences).not.toContain(
      "ws://127.0.0.1",
    );
    expect(local.bodyTextWithoutLocalOnlyDifferences).not.toContain("pid 4821");
    expect(remote.bodyTextWithoutLocalOnlyDifferences).not.toContain(
      "via relay",
    );

    // Asserted per variant rather than merely "they differ", so a tag that vanished, or two that swapped, fails
    // here.
    expect(local.kindTagLabel).toBe("Local");
    expect(remote.kindTagLabel).toBe("Remote");

    // The recovery console is absent in both - not a local/remote difference at all, so it stays inside the main
    // equality check too.
    expect(local.recoveryConsolePresent).toBe(false);
    expect(remote.recoveryConsolePresent).toBe(false);

    // Both halves are stated so that deleting the remote row, or growing a local one that should not exist without
    // a bridge, fails here instead of passing as "they agree".
    expect(remote.removalTestIds).toEqual([
      "settings-remove-host-from-account",
    ]);
    expect(local.removalTestIds).toEqual([]);
  });

  it("shows the RPC's hostVersion on the identity line, and NEVER the stale registry row version", async () => {
    // The row fixture defaults `version` to "1.4.2" (`hostScopeOptionFixture`); this pins the RPC's "1.5.0" as the
    // only version shown, for both variants.
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

/** Returned as nodes rather than strings so the caller deletes precisely them. */
function localOnlyNodes(root: HTMLElement): readonly Element[] {
  const nodes: Element[] = [];

  // Matching every leaf span in the panel by text would remove a genuine local-only fork rendering the same word
  // elsewhere along with the settled tag.
  const settledTags = kindTagNodes(root);
  if (settledTags.length > 1) {
    throw new Error(
      `expected exactly one kind tag in the identity card, found ${settledTags.length}`,
    );
  }
  nodes.push(...settledTags);

  // Only the removal row is the settled danger-zone exception.
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

/** Reads the same scoped row `localOnlyNodes` deletes, deliberately. */
function readKindTagLabel(root: HTMLElement): string | null {
  const tags = kindTagNodes(root);
  return tags.length === 1 ? tags[0].textContent.trim() : null;
}

function kindTagNodes(root: HTMLElement): readonly Element[] {
  const headingRow =
    root.querySelector('[data-testid="host-identity-card"] h2')
      ?.parentElement ?? null;
  if (headingRow === null) return [];
  return Array.from(headingRow.children).filter(
    (child) =>
      child.tagName === "SPAN" &&
      child.children.length === 0 &&
      (child.textContent.trim() === "Local" ||
        child.textContent.trim() === "Remote"),
  );
}
