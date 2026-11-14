import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationSourceContext,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { AddToConfigurationButton } from "@/components/settings/environment/add-to-configuration-button";

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => ({}) as ReturnType<typeof actual.useHostClient>,
  };
});
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => ({ major: 1, minor: 5 }),
}));
vi.mock("@/hooks/providers/use-providers-promote-to-personal-mutation", () => ({
  useProvidersPromoteToPersonal: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
}));

afterEach(cleanup);

function elementFor(configuration: "personal" | "team", role: string | null) {
  const source = {
    kind: "pool",
    configuration,
    environmentId: `env-${configuration}`,
    roomId: `room-${configuration}`,
    providerHandle: null,
    effectiveRole: role,
  } as unknown as ConfigurationSource;
  return (
    <ConfigurationSourceContext.Provider value={source}>
      <AddToConfigurationButton
        entryKind="mcp"
        providerId="claude-code"
        scope="global"
        workspaceRoot={null}
        name="scratch"
        configurationName={configuration === "personal" ? "Personal" : "Acme"}
      />
    </ConfigurationSourceContext.Provider>
  );
}

describe("AddToConfigurationButton role gate", () => {
  it("offers Add to Personal to its owner", () => {
    render(elementFor("personal", "owner"));

    expect(
      screen.getByRole("button", { name: "Add to Personal" }),
    ).toBeDefined();
  });

  it("offers Add to a team to an admin", () => {
    render(elementFor("team", "admin"));

    expect(screen.getByRole("button", { name: "Add to Acme" })).toBeDefined();
  });

  it("offers Add to a team to an editor", () => {
    render(elementFor("team", "editor"));

    expect(screen.getByRole("button", { name: "Add to Acme" })).toBeDefined();
  });

  it("hides Add from a viewer and a role the app does not know", () => {
    const view = render(elementFor("team", "viewer"));
    expect(screen.queryByRole("button", { name: "Add to Acme" })).toBeNull();

    view.rerender(elementFor("team", null));
    expect(screen.queryByRole("button", { name: "Add to Acme" })).toBeNull();
  });
});
