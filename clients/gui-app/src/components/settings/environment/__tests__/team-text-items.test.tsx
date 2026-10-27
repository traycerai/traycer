import { Component, type ReactNode } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentConfigurationItem,
  EnvironmentConfigurationItemWriteResponse,
} from "@traycer/protocol/host/environment/configuration-contracts";
import { TeamTextItems } from "@/components/settings/environment/team-text-items";
import {
  configurationItem,
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

class RenderBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? (
      <p role="alert">Render failed</p>
    ) : (
      this.props.children
    );
  }
}

function textItems(items: readonly EnvironmentConfigurationItem[]): ReactNode {
  return (
    <TeamTextItems
      items={items}
      kind="variable"
      os="any"
      providerId={null}
      onOutcome={() => undefined}
      renderDetails={() => null}
    />
  );
}

describe("TeamTextItems kind collisions", () => {
  it("waits for the variable after adding a name shared with a shell item", async () => {
    const shell = configurationItem({
      kind: "shell",
      key: "shell",
      os: "any",
      value: { path: "/bin/zsh", args: [] },
    });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 1,
      }),
    });
    const user = userEvent.setup();
    const view = (items: readonly EnvironmentConfigurationItem[]): ReactNode => (
      <RenderBoundary>{textItems(items)}</RenderBoundary>
    );
    const { rerender } = render(view([shell]), { wrapper: harness.Wrapper });

    await user.type(screen.getByLabelText("Variable name"), "shell");
    await user.type(screen.getByLabelText("New variable value"), "custom-shell");
    await user.click(screen.getByRole("button", { name: "Add a variable" }));

    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "shell · Adding",
    );
    rerender(
      view([
        shell,
        configurationItem({
          kind: "variable",
          key: "shell",
          os: "any",
          value: { value: "custom-shell" },
        }),
      ]),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Variable name")).toHaveProperty("value", "");
    });
    expect(screen.getByLabelText("shell value")).toHaveProperty(
      "value",
      "custom-shell",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("retains a disappearing variable during delete and observes its removal despite a shell collision", async () => {
    const shell = configurationItem({
      kind: "shell",
      key: "shell",
      os: "any",
      value: { path: "/bin/zsh", args: [] },
    });
    const variable = configurationItem({
      kind: "variable",
      key: "shell",
      os: "any",
      value: { value: "custom-shell" },
    });
    const deletion =
      Promise.withResolvers<EnvironmentConfigurationItemWriteResponse>();
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items.delete": () => deletion.promise,
    });
    const user = userEvent.setup();
    const { rerender } = render(textItems([shell, variable]), {
      wrapper: harness.Wrapper,
    });

    await user.click(
      within(screen.getByRole("region", { name: "shell" })).getByRole(
        "button",
        { name: "Delete" },
      ),
    );
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.delete"),
      ).toHaveLength(1);
    });
    rerender(textItems([shell]));

    expect(
      within(screen.getByRole("region", { name: "shell" })).getByRole("status"),
    ).toHaveProperty("textContent", "shell · Removing");
    await act(async () => {
      deletion.resolve({ outcome: "saved", revision: 2 });
      await deletion.promise;
    });

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "shell" })).toBeNull();
      expect(screen.getByLabelText("Variable name")).toHaveProperty("disabled", false);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
