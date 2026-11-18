import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerPlacement } from "@/hooks/host/use-composer-placement";
import { resolveLandingPlacement } from "@/lib/composer/landing-placement";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftNamedHostId,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  composerSurfaceKey,
  landingDraftSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

/**
 * The landing composer's placement for a draft opened FOR a host (Settings ▸
 * Mobile simulators' "Set up with an agent"): the draft's own host wins over
 * the window's pin and the effective host, stays put when that host dies,
 * and Send then refuses instead of creating the task elsewhere. Same
 * harness as `use-epic-conversation-placement.test.tsx`.
 */

vi.mock("@/lib/browser-tab-identity", () => ({
  browserTabId: () => "tab-test",
  subscribeBrowserTabId: () => () => {},
}));

const mocks = vi.hoisted(() => ({
  effectiveHostId: { current: "host-effective" },
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => ({
    getActiveHostId: () => hostId ?? "app-wide-mutable",
  }),
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mocks.effectiveHostId.current,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Studio Mac",
    unavailability: null,
  }),
  useRemoteSessionPollReadiness: () => true,
}));

const DRAFT = "draft-a";

function publishFleet(
  leases: ReadonlyArray<{
    readonly hostId: string;
    readonly status: "ready" | "dead";
  }>,
  effectiveHostId: string,
): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: effectiveHostId,
    targetHostId: effectiveHostId,
    effectiveHostId,
    leases: leases.map((lease) =>
      lease.status === "dead"
        ? { hostId: lease.hostId, status: "dead", dead: { reason: "offline" } }
        : { hostId: lease.hostId, status: "ready", dead: null },
    ),
    selectionRevision: 1,
  });
  mocks.effectiveHostId.current = effectiveHostId;
}

/** Opens `id` as a draft for `hostId` the way "Set up with an agent" does. */
function openNamedDraft(id: string, hostId: string | null): void {
  useLandingDraftStore.getState().installLandingDraft({
    id,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    selection: null,
    lastTouchedAt: 1,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    closed: false,
    returnedSandbox: null,
    namedHostId: hostId,
    durability: "in-memory",
  });
}

function placement() {
  return renderHook(() =>
    useComposerPlacement(useLandingDraftNamedHostId(DRAFT)),
  );
}

beforeEach(() => {
  useSurfaceHostSelectionStore.getState().resetForTests();
  useSelectionAuthorityStore.getState().reset();
  mocks.effectiveHostId.current = "host-effective";
});

afterEach(() => {
  cleanup();
  useSurfaceHostSelectionStore.getState().resetForTests();
  useSelectionAuthorityStore.getState().reset();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useStagedSandboxStore.setState({ bySurface: {} });
});

describe("a landing draft opened for a host", () => {
  it("places on that host, not on the effective host, while it is live", () => {
    openNamedDraft(DRAFT, "host-a");
    publishFleet(
      [
        { hostId: "host-a", status: "ready" },
        { hostId: "host-effective", status: "ready" },
      ],
      "host-effective",
    );
    const { result } = placement();
    expect(result.current.target.resolvedHostId).toBe("host-a");
    expect(result.current.target.namedHostDead).toBe(false);
  });

  it("stays on that host after it dies and refuses Send, never falling back to the effective host", () => {
    openNamedDraft(DRAFT, "host-a");
    publishFleet(
      [
        { hostId: "host-a", status: "dead" },
        { hostId: "host-effective", status: "ready" },
      ],
      "host-effective",
    );
    const { result } = placement();
    expect(result.current.target.resolvedHostId).toBe("host-a");
    expect(result.current.target.namedHostDead).toBe(true);
    expect(resolveLandingPlacement(result.current.submitTarget).kind).toBe(
      "refused",
    );
  });

  it("is unaffected by a second setup naming another host for another draft", () => {
    openNamedDraft(DRAFT, "host-a");
    openNamedDraft("draft-b", "host-b");
    publishFleet(
      [
        { hostId: "host-a", status: "ready" },
        { hostId: "host-b", status: "ready" },
      ],
      "host-b",
    );
    expect(placement().result.current.target.resolvedHostId).toBe("host-a");
  });

  it("follows the window as before when no host was named", () => {
    publishFleet(
      [{ hostId: "host-effective", status: "ready" }],
      "host-effective",
    );
    expect(placement().result.current.target.resolvedHostId).toBe(
      "host-effective",
    );
  });

  it("stages a sandbox for a named draft apart from the window's, so the window's stage never takes its Send", () => {
    const windowKey = composerSurfaceKey("tab-test");
    const target: StagedSandboxTarget = {
      kind: "existing",
      hostId: "host-effective",
      sandboxId: "sbx-1",
      name: "build-box",
      configuration: { kind: "personal" },
      verb: "resume",
    };
    useStagedSandboxStore.getState().stage(windowKey, target);
    const named = landingDraftSurfaceKey(windowKey, DRAFT, "host-a");
    const unnamed = landingDraftSurfaceKey(windowKey, "draft-b", null);
    expect(unnamed).toBe(windowKey);
    expect(named).not.toBe(windowKey);
    expect(readStagedSandbox(named)).toBeNull();
    // The window's stage is still there for the drafts that share it.
    expect(readStagedSandbox(windowKey)).not.toBeNull();
    expect(landingDraftSurfaceKey(windowKey, "draft-c", "host-a")).not.toBe(
      named,
    );
  });
});
