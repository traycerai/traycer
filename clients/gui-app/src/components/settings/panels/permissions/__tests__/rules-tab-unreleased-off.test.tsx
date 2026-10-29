/**
 * The build without sandboxes (`unreleased-features.ts`): Rules reads as the
 * release before them had it. Its footer is Discard and Save, with no reset
 * that would speak for every computer and sandbox, and its first section keeps
 * its own name, "Environment".
 */
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoPolicyGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { joinAutoPolicySections } from "@/components/settings/panels/auto-policy-document";
import { RulesTab } from "@/components/settings/panels/permissions/rules-tab";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

vi.mock("@/components/settings/host-scope/use-host-scope", () => {
  const useHostScope = () =>
    hostScopeFixture({ status: "following", hostId: "host-a" });
  return { useHostScope, usePersonalHostScope: useHostScope };
});
vi.mock(
  "@/components/settings/host-scope/use-scoped-host-binding",
  async () => {
    const { scopedHostBindingFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    return {
      useScopedHostBinding: (scope: HostScope) =>
        scopedHostBindingFixture(scope),
    };
  },
);
vi.mock("@/hooks/host/use-host-capability-probe", () => ({
  useHostCapabilityProbe: (args: {
    readonly client: unknown;
    readonly stale: boolean;
    readonly incarnation: ReadonlyArray<unknown>;
  }): void => {
    void args;
  },
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "autoPolicy.get" ? true : null,
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    method === "autoPolicy.set",
}));

const policy = vi.hoisted(
  (): { current: AutoPolicyGetResponse | undefined } => ({
    current: undefined,
  }),
);
vi.mock("@/hooks/auto-mode/use-auto-policy-query", () => ({
  useAutoPolicyQuery: () => ({
    data: policy.current,
    isError: false,
    refetch: () => Promise.resolve({ isError: false }),
  }),
}));
vi.mock("@/hooks/auto-mode/use-auto-policy-set-mutation", () => ({
  useAutoPolicySetMutation: () => ({
    mutate: () => undefined,
    isPending: false,
  }),
}));

const noop = (): void => undefined;

beforeEach(() => {
  // Custom rules stored, which is the one state the reset was offered in.
  policy.current = {
    body: joinAutoPolicySections({
      environment: "Staging: k8s-staging",
      allow: "- Run the linter",
      softDeny: "- Drop a table",
      hardDeny: "- Push to main",
      notes: "",
    }),
    updatedAt: "2026-09-10T00:00:00.000Z",
    source: "account",
    readState: "fresh",
  };
});

afterEach(cleanup);

describe("<RulesTab /> without sandboxes", () => {
  it("offers no reset in its footer", () => {
    render(
      <RulesTab
        active
        drafts={[]}
        onDraftsConsumed={noop}
        snapshot={null}
        onSnapshot={noop}
      />,
    );

    expect(screen.queryByTestId("auto-policy-reset")).toBeNull();
    expect(screen.getByTestId("auto-policy-discard")).not.toBeNull();
    expect(screen.getByTestId("auto-policy-save")).not.toBeNull();
  });

  it("names its first section Environment", () => {
    render(
      <RulesTab
        active
        drafts={[]}
        onDraftsConsumed={noop}
        snapshot={null}
        onSnapshot={noop}
      />,
    );

    const section = screen.getByTestId("auto-policy-section-environment");
    expect(section.textContent).toContain("Environment");
    expect(section.textContent).not.toContain("Trusted context");
  });
});
