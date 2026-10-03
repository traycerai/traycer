import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileSyncEntryButton } from "@/components/settings/panels/profile-sync/profile-sync-entry-button";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import {
  hostOption,
  managedProfile,
} from "../../profile-copy/__tests__/profile-copy-component-fixtures";

const SOURCE = "source-host";
const OTHER = "other-host";

const harness = vi.hoisted(
  (): {
    negotiated: ReadonlySet<string> | "unknown";
    hosts: HostScopeOption[];
  } => ({
    negotiated: "unknown",
    hosts: [],
  }),
);

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: harness.hosts,
    activeHostId: SOURCE,
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
  }),
}));

function answer(method: string): boolean | null {
  if (harness.negotiated === "unknown") return null;
  return harness.negotiated.has(method);
}

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    answer(method),
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    answer(method) === true,
}));

// The six sync verbs and the retry verb a started copy needs to recover.
const REQUIRED_METHODS = [
  "providers.profileCopy.sync.preview",
  "providers.profileCopy.sync.list",
  "providers.profileCopy.sync.start",
  "providers.profileCopy.sync.saveRule",
  "providers.profileCopy.sync.stopRule",
  "providers.profileCopy.sync.resolve",
  "providers.profileCopy.retry",
] as const;

// The verbs the legacy one-profile copy flow needs.
const COPY_METHODS = [
  "providers.profileCopy.preview",
  "providers.profileCopy.start",
  "providers.profileCopy.status",
  "providers.profileCopy.cancel",
  "providers.profileCopy.retry",
] as const;

function renderEntryWithProfile(
  hostId: string | null,
  providerId: ProviderId,
  profile: ProviderProfile | null,
): void {
  render(
    <TooltipProvider>
      <ProfileSyncEntryButton
        hostId={hostId}
        providerId={providerId}
        profile={profile}
      />
    </TooltipProvider>,
  );
}

function renderEntry(hostId: string | null, providerId: ProviderId): void {
  renderEntryWithProfile(hostId, providerId, null);
}

function reset(): void {
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
}

describe("ProfileSyncEntryButton", () => {
  beforeEach(() => {
    reset();
    harness.negotiated = new Set(REQUIRED_METHODS);
    harness.hosts = [
      hostOption(SOURCE, "Studio Mac", true),
      hostOption(OTHER, "Linux box", false),
    ];
  });
  afterEach(() => {
    cleanup();
    reset();
  });

  it("is enabled when the host negotiated every required verb, and opens the sync view for its provider", () => {
    renderEntry(SOURCE, "claude-code");
    const button = screen.getByRole("button", { name: /Sync profiles/ });
    expect(button.hasAttribute("disabled")).toBe(false);
    act(() => {
      button.click();
    });
    expect(useProfileCopyFlowStore.getState().view).toEqual({
      kind: "sync",
      sourceHostId: SOURCE,
      providerId: "claude",
    });
  });

  it.each(REQUIRED_METHODS)("is disabled when the host lacks %s", (missing) => {
    harness.negotiated = new Set(
      REQUIRED_METHODS.filter((method) => method !== missing),
    );
    renderEntry(SOURCE, "claude-code");
    const button = screen.getByRole("button", { name: /Sync profiles/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    act(() => {
      button.click();
    });
    expect(useProfileCopyFlowStore.getState().view).toBeNull();
  });

  it("is disabled while no handshake has answered yet", () => {
    harness.negotiated = "unknown";
    renderEntry(SOURCE, "claude-code");
    expect(
      screen
        .getByRole("button", { name: /Sync profiles/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("is disabled when the host negotiated nothing", () => {
    harness.negotiated = new Set();
    renderEntry(SOURCE, "codex");
    expect(
      screen
        .getByRole("button", { name: /Sync profiles/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it.each(["opencode", "cursor"] as const)(
    "is hidden for the %s provider, which profile copy cannot transfer",
    (providerId) => {
      renderEntry(SOURCE, providerId);
      expect(
        screen.queryByRole("button", { name: /Sync profiles/ }),
      ).toBeNull();
    },
  );

  it.each(["claude-code", "codex", "grok", "antigravity"] as const)(
    "is offered for the transferable %s provider",
    (providerId) => {
      renderEntry(SOURCE, providerId);
      expect(
        screen.getByRole("button", { name: /Sync profiles/ }),
      ).toBeTruthy();
    },
  );

  it("renders nothing without a host", () => {
    renderEntry(null, "claude-code");
    expect(screen.queryByRole("button", { name: /Sync profiles/ })).toBeNull();
  });

  describe("legacy copy fallback for a host without sync", () => {
    const PROFILE_ID = "66666666-6666-4666-8666-666666666666";
    const profile = (): ProviderProfile => managedProfile(PROFILE_ID, "Work");
    const copyButton = () =>
      screen.queryByRole("button", { name: /Copy to devices/ });
    const syncButton = () =>
      screen.queryByRole("button", { name: /Sync profiles/ });

    it("offers the one-profile copy for the selected profile when the host definitively lacks sync", () => {
      harness.negotiated = new Set(COPY_METHODS);
      renderEntryWithProfile(SOURCE, "claude-code", profile());
      expect(syncButton()).toBeNull();
      const button = copyButton();
      expect(button?.hasAttribute("disabled")).toBe(false);
      act(() => {
        button?.click();
      });
      expect(useProfileCopyFlowStore.getState().view).toEqual({
        kind: "new",
        sourceHostId: SOURCE,
        providerId: "claude",
        sourceProfileId: PROFILE_ID,
      });
    });

    it("keeps the copy fallback disabled when the host lacks part of the copy flow", () => {
      harness.negotiated = new Set(
        COPY_METHODS.filter(
          (method) => method !== "providers.profileCopy.cancel",
        ),
      );
      renderEntryWithProfile(SOURCE, "claude-code", profile());
      expect(syncButton()).toBeNull();
      expect(copyButton()?.hasAttribute("disabled")).toBe(true);
      act(() => {
        copyButton()?.click();
      });
      expect(useProfileCopyFlowStore.getState().view).toBeNull();
    });

    it("keeps Sync profiles for a host that negotiated sync, even with a profile", () => {
      harness.negotiated = new Set([...REQUIRED_METHODS, ...COPY_METHODS]);
      renderEntryWithProfile(SOURCE, "claude-code", profile());
      expect(copyButton()).toBeNull();
      expect(syncButton()?.hasAttribute("disabled")).toBe(false);
    });

    it("keeps the disabled Sync profiles while support is still pending, even with a profile", () => {
      harness.negotiated = "unknown";
      renderEntryWithProfile(SOURCE, "claude-code", profile());
      expect(copyButton()).toBeNull();
      expect(syncButton()?.hasAttribute("disabled")).toBe(true);
    });

    it("keeps the disabled Sync profiles without a profile, even when copy is negotiated", () => {
      harness.negotiated = new Set(COPY_METHODS);
      renderEntryWithProfile(SOURCE, "claude-code", null);
      expect(copyButton()).toBeNull();
      expect(syncButton()?.hasAttribute("disabled")).toBe(true);
    });
  });
});
