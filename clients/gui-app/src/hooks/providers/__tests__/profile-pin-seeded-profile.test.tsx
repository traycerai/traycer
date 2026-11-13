import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  pinProfile,
  providerState,
  removedEntry,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import {
  createProfileListHost,
  readinessFor,
  type ProfileListAnswer,
  type ProfileListHost,
} from "@/components/providers/__tests__/profile-pin-host-fixture";
import { useResolvedSeededProfileId } from "@/hooks/providers/use-resolved-seeded-profile-id";

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: object | null) => readinessFor(client),
}));

function managed(input: {
  readonly profileId: string;
  readonly label: string;
  readonly aliases: readonly string[];
}): ProviderProfile {
  return pinProfile({
    profileId: input.profileId,
    label: input.label,
    kind: "managed",
    enabled: true,
    authStatus: "authenticated",
    aliases: input.aliases,
    personNotice: null,
    terminalOnThisComputer: false,
    otherNames: [],
  });
}

function answerOf(
  profiles: readonly ProviderProfile[],
  removed: ProfileListAnswer["removedProfiles"],
): ProfileListAnswer {
  return {
    providers: [
      providerState({
        providerId: "codex",
        authStatus: "authenticated",
        profiles,
      }),
    ],
    native: null,
    removedProfiles: [...removed],
  };
}

function mount(
  profiles: readonly ProviderProfile[],
  removed: ProfileListAnswer["removedProfiles"],
  profileId: string | null,
): { readonly host: ProfileListHost; readonly current: () => string | null } {
  const host = createProfileListHost({
    answer: answerOf(profiles, removed),
    answerProfileName: (request) => ({ label: request.label }),
    failSetEnabled: false,
  });
  const view = renderHook(
    () => useResolvedSeededProfileId("codex", profileId, true, host.client),
    {
      wrapper: (props: { readonly children: ReactNode }) => (
        <host.Wrapper>{props.children}</host.Wrapper>
      ),
    },
  );
  return { host, current: () => view.result.current };
}

const desk = managed({ profileId: "desk-row", label: "Desk", aliases: [] });
const side = managed({ profileId: "side-row", label: "Side", aliases: [] });
const work = managed({
  profileId: "work-row",
  label: "Work",
  aliases: ["alias-work"],
});

describe("useResolvedSeededProfileId pin", () => {
  afterEach(() => cleanup());

  it("an alias seed becomes the canonical row's id", async () => {
    const { host, current } = mount([side, work], [], "alias-work");
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(current()).toBe("work-row");
    });
  });

  it("a removed profile id is kept", async () => {
    const { host, current } = mount(
      [side, work],
      [
        removedEntry({
          providerId: "codex",
          profileId: "gone-row",
          aliases: [],
        }),
      ],
      "gone-row",
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
    });
    expect(current()).toBe("gone-row");
  });

  it("a removed entry's alias is kept", async () => {
    const { host, current } = mount(
      [side, work],
      [
        removedEntry({
          providerId: "codex",
          profileId: "gone-row",
          aliases: ["gone-alias"],
        }),
      ],
      "gone-alias",
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
    });
    expect(current()).toBe("gone-alias");
  });

  it("an unknown id becomes null once the list has arrived", async () => {
    const { host, current } = mount([side, work], [], "missing-id");
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(current()).toBeNull();
    });
  });

  it("two rows listing one id become null", async () => {
    const sharedSide = managed({
      profileId: "shared-id",
      label: "Side",
      aliases: [],
    });
    const sharedWork = managed({
      profileId: "work-row",
      label: "Work",
      aliases: ["shared-id"],
    });
    const { host, current } = mount(
      [desk, sharedSide, sharedWork],
      [],
      "shared-id",
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(current()).toBeNull();
    });
  });

  it("two aliases of one id become null", async () => {
    const aliasSide = managed({
      profileId: "side-row",
      label: "Side",
      aliases: ["shared-id"],
    });
    const aliasWork = managed({
      profileId: "work-row",
      label: "Work",
      aliases: ["shared-id"],
    });
    const { host, current } = mount(
      [desk, aliasSide, aliasWork],
      [],
      "shared-id",
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(current()).toBeNull();
    });
  });

  it("an id a row lists stays that row when a removed entry also lists it", async () => {
    const kept = managed({
      profileId: "work-row",
      label: "Work",
      aliases: ["kept-id"],
    });
    const { host, current } = mount(
      [desk, kept],
      [
        removedEntry({
          providerId: "codex",
          profileId: "gone-row",
          aliases: ["kept-id"],
        }),
      ],
      "kept-id",
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(current()).toBe("work-row");
    });
  });
});
