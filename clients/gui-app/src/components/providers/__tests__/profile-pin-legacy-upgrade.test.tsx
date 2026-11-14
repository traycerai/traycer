import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode, RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { upgradeResponseToVersion } from "@traycer/protocol/framework/versioned-rpc";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { PickerProfileDropdown } from "@/components/home/pickers/picker-profile-dropdown";
import {
  createProfileListHost,
  readinessFor,
  type ProfileListHost,
} from "@/components/providers/__tests__/profile-pin-host-fixture";
import { useResolvedSeededProfileId } from "@/hooks/providers/use-resolved-seeded-profile-id";
import type { HostRpcRegistry } from "@/lib/host";

const holder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/components/ui/dropdown-menu", async () =>
  (
    await import("@/components/providers/__tests__/profile-dropdown-menu-mock")
  ).profileDropdownMenuMock(),
);

vi.mock("@/hooks/rate-limits/use-profile-usage-presentation", () => ({
  useProfileUsagePresentation: () => null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => holder.client,
  useHostDirectoryEntryForHostId: () => null,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: object | null) => readinessFor(client),
}));

const INPUT_REF: RefObject<HTMLInputElement | null> = { current: null };

const listLine = hostRpcRegistry["providers.list"][10];

function profileFields(input: {
  readonly profileId: string;
  readonly kind: "ambient" | "managed";
  readonly label: string;
}) {
  return {
    profileId: input.profileId,
    kind: input.kind,
    label: input.label,
    enabled: true,
    authType: "oauth" as const,
    auth: {
      status: "authenticated" as const,
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown" as const,
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

/** A 10.10 answer, upgraded by the real registry path to 10.11. */
function upgradedAnswer() {
  const older = {
    providers: [
      {
        providerId: "claude-code" as const,
        enabled: true,
        disabledBy: null,
        selected: { kind: "bundled" as const },
        candidates: [],
        auth: {
          status: "authenticated" as const,
          badgeText: null,
          label: null,
          detail: null,
        },
        authPending: false,
        checkedAt: null,
        apiKey: { supported: false, configured: false, source: null },
        terminalAgentArgs: "",
        envOverrides: [],
        loginCapability: null,
        profiles: [
          profileFields({
            profileId: "ambient-row",
            kind: "ambient",
            label: "Desk login",
          }),
          profileFields({
            profileId: "work-row",
            kind: "managed",
            label: "Work",
          }),
        ],
      },
    ],
    native: null,
  };
  const parsed = listLine.versions[10].contract.responseSchema.parse(older);
  const upgraded = upgradeResponseToVersion(
    hostRpcRegistry["providers.list"],
    { major: 10, minor: 10 },
    { major: 10, minor: 11 },
    parsed,
  );
  return listLine.versions[11].contract.responseSchema.parse(upgraded);
}

function requiredRemovedProfiles<T>(removed: readonly T[] | undefined): T[] {
  expect(removed).toBeDefined();
  if (removed === undefined) {
    throw new Error("a 10.11 providers.list answer includes removedProfiles");
  }
  return [...removed];
}

function mountDropdown(profileId: string | null): ProfileListHost {
  const answer = upgradedAnswer();
  const provider = answer.providers[0];
  const host = createProfileListHost({
    answer: {
      providers: [provider],
      native: null,
      removedProfiles: requiredRemovedProfiles(answer.removedProfiles),
    },
    answerProfileName: (request) => ({ label: request.label }),
    failSetEnabled: false,
  });
  holder.client = host.client;
  render(
    <host.Wrapper>
      <PickerProfileDropdown
        providerId="claude"
        providerLabel="Claude"
        profiles={provider.profiles}
        activeProfileId={profileId}
        onSelectProfile={() => undefined}
        onCreateProfile={() => undefined}
        createProfileDisabled={false}
        createProfileDisabledReason={undefined}
        shortcutHintForIndex={() => null}
        profileEnablementPending={() => false}
        contentContainer={null}
        inputRef={INPUT_REF}
        runTargetHostId={host.hostId}
        admissionByProfileId={null}
      />
    </host.Wrapper>,
  );
  return host;
}

describe("a 10.10 answer upgraded to 10.11", () => {
  afterEach(() => {
    holder.client = null;
    cleanup();
  });

  it("shows the named row, and the first row with nothing checked for an unknown id", () => {
    const answer = upgradedAnswer();
    const provider = answer.providers[0];
    const ambient = provider.profiles[0];
    const managed = provider.profiles[1];
    expect(answer.removedProfiles).toEqual([]);
    expect(ambient.terminalOnThisComputer).toBe(true);
    expect(managed.terminalOnThisComputer).toBe(false);
    expect(ambient.aliases).toEqual([]);
    expect(managed.otherNames).toEqual([]);

    mountDropdown("work-row");
    expect(
      screen
        .getByRole("button", { name: /^Claude profile: / })
        .getAttribute("aria-label"),
    ).toBe("Claude profile: Work");
    expect(
      screen
        .getByRole("menuitem", { current: true })
        .getAttribute("aria-label"),
    ).toContain("Work");
    cleanup();

    mountDropdown("missing-id");
    expect(
      screen
        .getByRole("button", { name: /^Claude profile: / })
        .getAttribute("aria-label"),
    ).toBe("Claude profile: Desk login, Terminal");
    expect(screen.queryByRole("menuitem", { current: true })).toBeNull();
  });

  it("keeps a listed seed and clears an unknown seed", async () => {
    const answer = upgradedAnswer();
    const provider = answer.providers[0];
    const host = createProfileListHost({
      answer: {
        providers: [provider],
        native: null,
        removedProfiles: requiredRemovedProfiles(answer.removedProfiles),
      },
      answerProfileName: (request) => ({ label: request.label }),
      failSetEnabled: false,
    });
    const known = renderHook(
      () => useResolvedSeededProfileId("claude", "work-row", true, host.client),
      {
        wrapper: (props: { readonly children: ReactNode }) => (
          <host.Wrapper>{props.children}</host.Wrapper>
        ),
      },
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(known.result.current).toBe("work-row");
    });
    cleanup();
    const unknown = renderHook(
      () =>
        useResolvedSeededProfileId("claude", "missing-id", true, host.client),
      {
        wrapper: (props: { readonly children: ReactNode }) => (
          <host.Wrapper>{props.children}</host.Wrapper>
        ),
      },
    );
    await waitFor(() => {
      expect(unknown.result.current).toBeNull();
    });
  });
});
