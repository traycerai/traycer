import { describe, expect, it } from "vitest";
import type { EnvironmentPlan } from "@traycer/protocol/host/environment/configuration-contracts";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import { teamProviderStateWord } from "../team-provider-state-word";

function plan(
  harness: string,
  status: EnvironmentPlan["status"],
): EnvironmentPlan {
  return {
    profileId: `profile-${harness}`,
    harness,
    status,
    linkedBy: { name: "Ada", you: false },
  };
}

function providerKey(
  name: string,
  overrides: Partial<EnvironmentSecret>,
): EnvironmentSecret {
  return {
    secretId: `secret-${name}`,
    name,
    kind: "provider",
    protocol: null,
    destinations: [],
    mode: "brokered",
    state: "live",
    currentVersionId: "v1",
    revoked: false,
    updatedAt: 1,
    ...overrides,
  };
}

describe("teamProviderStateWord", () => {
  it("states nothing while the plans or the secrets are still being read", () => {
    const base = { providerId: "cursor", harnessId: "cursor" } as const;
    expect(teamProviderStateWord({ ...base, plans: null, secrets: [] })).toBe(
      null,
    );
    expect(teamProviderStateWord({ ...base, plans: [], secrets: null })).toBe(
      null,
    );
  });

  it("says plan when an admin's plan is linked for the provider's harness", () => {
    expect(
      teamProviderStateWord({
        providerId: "claude-code",
        harnessId: "claude",
        plans: [plan("claude", "linked")],
        secrets: [],
      }),
    ).toBe("plan");
  });

  it("does not count another harness's plan or a plan that is not linked", () => {
    expect(
      teamProviderStateWord({
        providerId: "claude-code",
        harnessId: "claude",
        plans: [plan("codex", "linked"), plan("claude", "expired")],
        secrets: [],
      }),
    ).toBe("no plan");
  });

  it("says key for a live team key under the provider's variable", () => {
    expect(
      teamProviderStateWord({
        providerId: "cursor",
        harnessId: "cursor",
        plans: [],
        secrets: [providerKey("CURSOR_API_KEY", {})],
      }),
    ).toBe("key");
  });

  it.each([
    ["revoked", { revoked: true }],
    ["awaiting review", { state: "pending_review" }],
    ["not a provider secret", { kind: "api_key" }],
    ["another provider's variable", { name: "KIRO_API_KEY" }],
  ] as const)("does not count a key that is %s", (_label, overrides) => {
    expect(
      teamProviderStateWord({
        providerId: "cursor",
        harnessId: "cursor",
        plans: [],
        secrets: [providerKey("CURSOR_API_KEY", overrides)],
      }),
    ).toBe("no plan");
  });

  it("prefers plan over key, and says no plan for a provider that takes no key", () => {
    expect(
      teamProviderStateWord({
        providerId: "cursor",
        harnessId: "cursor",
        plans: [plan("cursor", "linked")],
        secrets: [providerKey("CURSOR_API_KEY", {})],
      }),
    ).toBe("plan");
    expect(
      teamProviderStateWord({
        providerId: "claude-code",
        harnessId: "claude",
        plans: [],
        secrets: [providerKey("CURSOR_API_KEY", {})],
      }),
    ).toBe("no plan");
  });
});
