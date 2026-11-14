import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import { TeamSkillsPage } from "@/components/settings/environment/team-skills";
import { TeamPermissions } from "@/components/settings/environment/team-permissions";
import { BrowserAgentAccessGroup } from "@/components/settings/panels/browser-agent-access-group";
import { TeamVariablesAndShells } from "@/components/settings/environment/team-variables-and-shells";
import { SettingsSectionContext } from "@/components/settings/settings-section-context";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { reachableHost } from "./mcp-skills-test-support";
import {
  configurationItem,
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

// Resolving a client for another host needs the app's host directory; the
// viewing-host logic above it stays real.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSettingsEnvironmentPickStore.setState({ pick: null });
  setPhoneLayoutOnly(false);
});

const variable = (
  key: string,
  value: string,
  revision: number,
): EnvironmentConfigurationItem =>
  configurationItem({
    kind: "variable",
    key,
    os: "any",
    value: { value },
    revision,
  });

async function selectOs(user: UserEvent, name: string): Promise<void> {
  await user.click(screen.getByRole("combobox", { name: "Operating system" }));
  await user.click(await screen.findByRole("option", { name }));
}

function pageDescription(): HTMLElement {
  const heading = screen.getByRole("heading", { level: 1 });
  const header = heading.closest("header");
  if (header === null) throw new Error("page heading has no header");
  const paragraph = Array.from(header.querySelectorAll("p")).find(
    (node) => node.dataset.testid !== "settings-phone-scope-line",
  );
  if (paragraph === undefined) {
    throw new Error("page header has no description");
  }
  return paragraph;
}

async function expectSentence(
  text: string,
  name: string,
  split: boolean,
): Promise<void> {
  await waitFor(() => {
    expect(pageDescription().textContent).toBe(text);
  });
  if (!split) return;
  const nameNode = within(pageDescription()).getByText(name);
  expect(nameNode.tagName).toBe("SPAN");
  expect(nameNode.className).toContain("truncate");
}

function shellEditor(): HTMLElement {
  const section = screen.getByLabelText("Shell path").closest("section");
  if (section === null) throw new Error("Shell path has no editor section");
  return section;
}

describe("TeamVariablesAndShells", () => {
  it("keeps saved and new variable fields and shell controls visible", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [variable("NODE_ENV", "production", 3)],
      }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    const row = await screen.findByRole("region", { name: "NODE_ENV" });
    expect(within(row).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "value",
      "production",
    );
    expect(within(row).queryByRole("combobox")).toBeNull();
    expect(
      within(row).getByRole("button", { name: "Remove NODE_ENV" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("New variable name")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Add a variable" }),
    );
    expect(screen.getByRole("region", { name: "New variable" })).toBeTruthy();
    expect(screen.getByLabelText("New variable name")).toBeTruthy();
    expect(screen.getByLabelText("New variable value")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply variable" })).toBeTruthy();
    expect(screen.getByLabelText("Shell path")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
  });

  it.each(["darwin-arm64", null])(
    "keeps every live value in its own card when the host platform is %s",
    async (hostPlatform) => {
      const harness = mountTeamPage(poolSource("editor"), {
        "environment.configuration.items": () => ({
          items: [
            variable("NODE_ENV", "production", 3),
            configurationItem({
              kind: "variable",
              key: "NODE_ENV",
              os: "macos",
              value: { value: "mac-production" },
              revision: 3,
            }),
            configurationItem({
              kind: "variable",
              key: "LINUX_URL",
              os: "linux",
              value: { value: "saved-linux" },
              revision: 2,
            }),
            configurationItem({
              kind: "shell",
              key: "shell",
              os: "macos",
              value: { path: "/bin/fish", args: [] },
              revision: 2,
            }),
          ],
        }),
        "environment.host.list": () => ({
          hosts: [{ ...reachableHost, hostPlatform }],
        }),
        "config.env.list": () => ({
          entries: [
            { key: "NODE_ENV", value: "staging" },
            { key: "LINUX_URL", value: "live-linux" },
            { key: "HOST_ONLY", value: "host-value" },
          ],
        }),
        "config.shell.get": () => ({
          path: "/bin/zsh",
          args: ["-l"],
          synthesised: false,
        }),
      });
      const user = userEvent.setup();
      render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

      const live = await screen.findByRole("region", { name: "Live values" });
      expect(await within(live).findByText("Applied on Mac mini")).toBeTruthy();
      expect(await within(live).findByText("/bin/zsh -l")).toBeTruthy();
      for (const value of ["staging", "live-linux", "host-value"]) {
        expect(await within(live).findByText(`: ${value}`)).toBeTruthy();
      }
      const variableRow = screen.getByRole("region", { name: "NODE_ENV" });
      expect(
        within(variableRow).getByLabelText("Value for NODE_ENV"),
      ).toHaveProperty("value", "production");
      expect(screen.queryByText(/This host uses/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Details" })).toBeNull();

      await selectOs(user, "macOS");
      expect(screen.getByLabelText("Shell path")).toHaveProperty(
        "value",
        "/bin/fish",
      );
      expect(within(live).getByText("/bin/zsh -l")).toBeTruthy();
      await selectOs(user, "Linux");
      expect(screen.getByLabelText("Value for LINUX_URL")).toHaveProperty(
        "value",
        "saved-linux",
      );
      expect(within(live).getByText(": staging")).toBeTruthy();
      expect(screen.queryByText(/This host uses/)).toBeNull();
    },
  );

  it("reads the team's items by environment id, never the host's own config", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [variable("NODE_ENV", "production", 3)],
      }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    expect(await screen.findByLabelText("Value for NODE_ENV")).toHaveProperty(
      "value",
      "production",
    );
    expect(harness.paramsOf("environment.configuration.items")[0]).toEqual({
      environmentId: "env-a",
    });
    expect(harness.paramsOf("config.env.list")).toHaveLength(0);
    expect(harness.paramsOf("config.shell.get")).toHaveLength(0);
  });

  it("names the team in the subtitle, and a failed read shows one line whose Retry reads again", async () => {
    let fail = true;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => {
        if (fail) throw new Error("host unavailable");
        return { items: [variable("NODE_ENV", "production", 3)] };
      },
      "environment.host.list": () => ({ hosts: [] }),
      "environment.list": () => ({
        environments: [
          {
            environmentId: "env-a",
            ownerKind: "organization" as const,
            ownerId: "team-a",
            roomId: "room-a",
            label: "Acme",
            effectiveRole: "editor" as const,
            kind: "team" as const,
            hostCount: 1,
            providerHandle: "handle-a",
          },
        ],
      }),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    const failure = await screen.findByText(
      "Couldn't read Acme's variables and shells.",
    );
    await expectSentence(
      "Plain values every host running Acme gets, and the shell agents run in.",
      "Acme",
      true,
    );
    const reads = harness.paramsOf("environment.configuration.items").length;

    fail = false;
    await userEvent.click(
      within(failure.closest("p") ?? failure).getByRole("button", {
        name: "Retry",
      }),
    );

    expect(await screen.findByLabelText("Value for NODE_ENV")).toBeTruthy();
    expect(
      harness.paramsOf("environment.configuration.items").length,
    ).toBeGreaterThan(reads);
  });

  it("gives a viewer the values with no Save, Delete or new-variable verbs", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.configuration.items": () => ({
        items: [variable("NODE_ENV", "production", 3)],
      }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("production")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    for (const verb of [
      "Save",
      "Delete",
      "Add a variable",
      "Apply variable",
      "Remove NODE_ENV",
    ]) {
      expect(screen.queryByRole("button", { name: verb })).toBeNull();
    }
  });

  it("keeps a variable draft through an immediate current conflict until a deliberate save", async () => {
    let current = variable("NODE_ENV", "production", 3);
    let puts = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [current] }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) {
          current = variable("NODE_ENV", "staging", 4);
          return {
            outcome: "conflict",
            current: { revision: 4, changedBy: "Grace", changedAt: 2 },
          };
        }
        current = variable("NODE_ENV", "development!", 5);
        return { outcome: "saved", revision: 5 };
      },
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });
    const field = await screen.findByLabelText("Value for NODE_ENV");
    await userEvent.clear(field);
    await userEvent.type(field, "development");
    fireEvent.blur(screen.getByLabelText("Value for NODE_ENV"));
    expect(
      await screen.findByText("Changed by Grace a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByLabelText("Value for NODE_ENV")).toHaveProperty(
        "value",
        "development",
      );
      expect(screen.getByLabelText("Value for NODE_ENV")).toHaveProperty(
        "disabled",
        false,
      );
    });
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "variable",
        key: "NODE_ENV",
        os: "any",
        value: { value: "development" },
        revision: 3,
      },
    ]);
    await userEvent.type(screen.getByLabelText("Value for NODE_ENV"), "!");
    fireEvent.blur(screen.getByLabelText("Value for NODE_ENV"));
    await waitFor(() => {
      expect(screen.getByLabelText("Value for NODE_ENV")).toHaveProperty(
        "disabled",
        false,
      );
    });
    expect(
      harness.paramsOf("environment.configuration.items.put")[1],
    ).toMatchObject({ revision: 4, value: { value: "development!" } });
    expect(screen.getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "value",
      "development!",
    );
  });

  it("shows and saves each operating system's own value when two share a key and revision", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [
          variable("NODE_ENV", "production", 3),
          configurationItem({
            kind: "variable",
            key: "NODE_ENV",
            os: "linux",
            value: { value: "linux-value" },
            revision: 3,
          }),
        ],
      }),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 4,
      }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    const user = userEvent.setup();
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    expect(
      within(
        await screen.findByRole("region", { name: "NODE_ENV" }),
      ).getByLabelText("Value for NODE_ENV"),
    ).toHaveProperty("value", "production");
    await user.click(
      screen.getByRole("combobox", { name: "Operating system" }),
    );
    await user.click(await screen.findByRole("option", { name: "Linux" }));
    const field = screen.getByLabelText("Value for NODE_ENV");
    expect(field).toHaveProperty("value", "linux-value");

    await user.type(field, "!");
    fireEvent.blur(screen.getByLabelText("Value for NODE_ENV"));
    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "variable",
          key: "NODE_ENV",
          os: "linux",
          value: { value: "linux-value!" },
          revision: 3,
        },
      ]);
    });
  });

  it("lists every operating system's variables under All, labels the ones scoped to one, and saves each under its own", async () => {
    let items = [
      configurationItem({
        kind: "variable",
        key: "API_URL",
        os: "macos",
        value: { value: "mac-value" },
        revision: 2,
      }),
    ];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        items = items.map((item) => ({
          ...item,
          value: { value: "mac-value!" },
          revision: 3,
        }));
        return { outcome: "saved", revision: 3 };
      },
      "environment.host.list": () => ({ hosts: [] }),
    });
    const user = userEvent.setup();
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    const row = await screen.findByRole("region", { name: "API_URL · macOS" });
    expect(within(row).getByText("macOS")).toBeTruthy();
    expect(screen.queryByText("No variables.")).toBeNull();
    expect(
      within(row).getByRole("button", { name: "Remove API_URL" }),
    ).toBeTruthy();
    const field = within(row).getByLabelText("Value for API_URL");
    expect(field).toHaveProperty("value", "mac-value");

    await user.type(field, "!");
    fireEvent.blur(screen.getByLabelText("Value for API_URL"));
    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "variable",
          key: "API_URL",
          os: "macos",
          value: { value: "mac-value!" },
          revision: 2,
        },
      ]);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Value for API_URL")).toHaveProperty(
        "disabled",
        false,
      );
    });
    await user.click(
      screen.getByRole("combobox", { name: "Operating system" }),
    );
    await user.click(await screen.findByRole("option", { name: "Linux" }));
    expect(screen.queryByRole("region", { name: /API_URL/ })).toBeNull();
    expect(screen.getByText("No variables.")).toBeTruthy();
  });

  it("shows an added variable's awaiting-readback line, Retry and row only under the operating system it was added to", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [] }),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 1,
      }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    const user = userEvent.setup();
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });
    await selectOs(user, "Linux");
    await user.click(screen.getByRole("button", { name: "Add a variable" }));
    await user.type(screen.getByLabelText("New variable name"), "API_URL");
    await user.click(screen.getByRole("button", { name: "Apply variable" }));
    const refreshed = "Saved, but latest settings haven't refreshed.";
    expect(await screen.findByText(refreshed)).toBeTruthy();
    expect(screen.getByText("API_URL")).toBeTruthy();
    expect(screen.queryByText("No variables.")).toBeNull();

    await selectOs(user, "macOS");
    expect(screen.queryByText(refreshed)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("API_URL")).toBeNull();
    expect(screen.getByText("No variables.")).toBeTruthy();
    await selectOs(user, "Linux");
    expect(screen.getByText(refreshed)).toBeTruthy();
  });

  describe("a shell write", () => {
    const shellItem = configurationItem({
      kind: "shell",
      key: "shell",
      os: "any",
      value: { path: "/bin/bash", args: [] },
      revision: 3,
    });

    const typeNewPath = async (user: UserEvent): Promise<void> => {
      const field = await screen.findByLabelText("Shell path");
      await user.clear(field);
      await user.type(field, "/bin/zsh");
      await user.click(
        within(shellEditor()).getByRole("button", { name: "Save" }),
      );
    };

    it("keeps an accepted shell through stale read retries, then uses the confirmed revision on its next save", async () => {
      let current = shellItem;
      let puts = 0;
      const harness = mountTeamPage(poolSource("editor"), {
        "environment.configuration.items": () => ({ items: [current] }),
        "environment.configuration.items.put": () => {
          puts += 1;
          if (puts === 2)
            current = {
              ...shellItem,
              revision: 5,
              value: { path: "/bin/fish", args: [] },
            };
          return { outcome: "saved", revision: puts === 1 ? 4 : 5 };
        },
        "environment.host.list": () => ({ hosts: [] }),
      });
      const user = userEvent.setup();
      render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });
      await typeNewPath(user);
      expect(
        await screen.findByText(
          "Saved, but latest settings haven't refreshed.",
        ),
      ).toBeTruthy();
      expect(screen.getByLabelText("Shell path")).toHaveProperty(
        "value",
        "/bin/zsh",
      );
      const reads = harness.paramsOf("environment.configuration.items").length;
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(
        await screen.findByText(
          "Saved, but latest settings haven't refreshed.",
        ),
      ).toBeTruthy();
      expect(harness.paramsOf("environment.configuration.items")).toHaveLength(
        reads + 1,
      );
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(1);
      expect(screen.getByLabelText("Shell path")).toHaveProperty(
        "disabled",
        true,
      );
      current = {
        ...shellItem,
        revision: 4,
        value: { path: "/bin/zsh", args: [] },
      };
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => {
        expect(screen.getByLabelText("Shell path")).toHaveProperty(
          "disabled",
          false,
        );
      });
      await user.click(screen.getByLabelText("Shell path"));
      await user.clear(screen.getByLabelText("Shell path"));
      await user.type(screen.getByLabelText("Shell path"), "/bin/fish");
      await user.click(
        within(shellEditor()).getByRole("button", { name: "Save" }),
      );
      await waitFor(() => {
        expect(screen.getByLabelText("Shell path")).toHaveProperty(
          "disabled",
          false,
        );
      });
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "shell",
          key: "shell",
          os: "any",
          value: { path: "/bin/zsh", args: [] },
          revision: 3,
        },
        {
          environmentId: "env-a",
          kind: "shell",
          key: "shell",
          os: "any",
          value: { path: "/bin/fish", args: [] },
          revision: 4,
        },
      ]);
      expect(screen.queryByText(/(?:Saved|Removed)[.,]/)).toBeNull();
    });

    it("shows a shell write's pending line only on the operating system it addresses", async () => {
      const put = Promise.withResolvers<{
        outcome: "saved";
        revision: number;
      }>();
      const harness = mountTeamPage(poolSource("editor"), {
        "environment.configuration.items": () => ({ items: [shellItem] }),
        "environment.configuration.items.put": () => put.promise,
        "environment.host.list": () => ({ hosts: [] }),
      });
      const user = userEvent.setup();
      render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });
      await typeNewPath(user);
      expect(await screen.findByText("shell · Saving")).toBeTruthy();

      await selectOs(user, "Linux");
      expect(screen.queryByText("shell · Saving")).toBeNull();
      await selectOs(user, "All operating systems");
      expect(screen.getByText("shell · Saving")).toBeTruthy();
    });

    it("shows a shell write's awaiting-readback line and Retry only on the operating system it addresses", async () => {
      const harness = mountTeamPage(poolSource("editor"), {
        "environment.configuration.items": () => ({ items: [shellItem] }),
        "environment.configuration.items.put": () => ({
          outcome: "saved",
          revision: 4,
        }),
        "environment.host.list": () => ({ hosts: [] }),
      });
      const user = userEvent.setup();
      render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });
      await typeNewPath(user);
      const refreshed = "Saved, but latest settings haven't refreshed.";
      expect(await screen.findByText(refreshed)).toBeTruthy();

      await selectOs(user, "Linux");
      expect(screen.queryByText(refreshed)).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      await selectOs(user, "All operating systems");
      expect(screen.getByText(refreshed)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    it("keeps a revisionless accepted Remove pending until a read confirms absence, then allows a fresh create", async () => {
      let items = [shellItem];
      const harness = mountTeamPage(poolSource("editor"), {
        "environment.configuration.items": () => ({ items }),
        "environment.configuration.items.delete": () => ({
          outcome: "saved",
          revision: null,
        }),
        "environment.configuration.items.put": () => {
          items = [
            {
              ...shellItem,
              revision: 5,
              value: { path: "/bin/zsh", args: [] },
            },
          ];
          return { outcome: "saved", revision: 5 };
        },
        "environment.host.list": () => ({ hosts: [] }),
      });
      const user = userEvent.setup();
      render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });
      await user.click(await screen.findByRole("button", { name: "Remove" }));
      expect(
        await screen.findByText(
          "Removed, but latest settings haven't refreshed.",
        ),
      ).toBeTruthy();
      expect(screen.getByLabelText("Shell path")).toHaveProperty("value", "");
      expect(screen.getByLabelText("Shell path")).toHaveProperty(
        "disabled",
        true,
      );
      const reads = harness.paramsOf("environment.configuration.items").length;
      items = [{ ...shellItem, revision: 4 }];
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(
        await screen.findByText(
          "Removed, but latest settings haven't refreshed.",
        ),
      ).toBeTruthy();
      expect(screen.getByLabelText("Shell path")).toHaveProperty(
        "disabled",
        true,
      );
      items = [];
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => {
        expect(screen.getByLabelText("Shell path")).toHaveProperty(
          "disabled",
          false,
        );
      });
      expect(harness.paramsOf("environment.configuration.items")).toHaveLength(
        reads + 2,
      );
      expect(
        harness.paramsOf("environment.configuration.items.delete"),
      ).toEqual([
        {
          environmentId: "env-a",
          kind: "shell",
          key: "shell",
          os: "any",
          revision: 3,
        },
      ]);
      await typeNewPath(user);
      await waitFor(() => {
        expect(screen.getByLabelText("Shell path")).toHaveProperty(
          "disabled",
          false,
        );
      });
      expect(
        harness.paramsOf("environment.configuration.items.put")[0],
      ).toMatchObject({ revision: null });
      expect(screen.queryByText(/(?:Saved|Removed)[.,]/)).toBeNull();
    });

    it("keeps a shell draft through an immediate current conflict and deliberately saves on the fresh revision", async () => {
      let current = shellItem;
      let conflicted = false;
      const harness = mountTeamPage(poolSource("editor"), {
        "environment.configuration.items": () => ({ items: [current] }),
        "environment.configuration.items.put": () => {
          if (!conflicted) {
            conflicted = true;
            current = {
              ...shellItem,
              revision: 4,
              value: { path: "/bin/sh", args: [] },
            };
            return {
              outcome: "conflict",
              current: { revision: 4, changedBy: "Grace", changedAt: 2 },
            };
          }
          current = {
            ...shellItem,
            revision: 5,
            value: { path: "/bin/zsh", args: [] },
          };
          return { outcome: "saved", revision: 5 };
        },
        "environment.host.list": () => ({ hosts: [] }),
      });
      const user = userEvent.setup();
      render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });
      await typeNewPath(user);
      expect(
        await screen.findByText("Changed by Grace a moment ago"),
      ).toBeTruthy();
      expect(screen.getByLabelText("Shell path")).toHaveProperty(
        "value",
        "/bin/zsh",
      );
      expect(
        within(shellEditor()).getByRole("button", { name: "Save" }),
      ).toHaveProperty("disabled", false);
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(1);
      await user.click(
        within(shellEditor()).getByRole("button", { name: "Save" }),
      );
      await waitFor(() => {
        expect(screen.getByLabelText("Shell path")).toHaveProperty(
          "disabled",
          false,
        );
      });
      expect(
        harness.paramsOf("environment.configuration.items.put")[1],
      ).toMatchObject({ revision: 4 });
      expect(screen.queryByText(/(?:Saved|Removed)[.,]/)).toBeNull();
    });
  });

  it("says live values need a host while the team has none", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [] }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText(/Live values need a host running/),
    ).toBeTruthy();
    expect(harness.paramsOf("config.shell.get")).toHaveLength(0);
  });

  it("claims nothing about where the team runs while the host list is still being read", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [] }),
      // The inventory never answers: this is the state every first paint of
      // the card passes through.
      "environment.host.list": () => new Promise<never>(() => undefined),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    await screen.findByRole("heading", { name: "Variables & shells" });
    // An unread inventory cannot justify recommending a sandbox.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Applied on Mac mini")).toBeNull();
    expect(
      await screen.findByRole("region", { name: "Live values" }),
    ).toBeTruthy();
    expect(screen.queryByText(/sandbox to see/)).toBeNull();
  });

  it("says the host list could not be read, with Retry, rather than that the team runs nowhere", async () => {
    const world = { failing: true };
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [] }),
      "environment.host.list": () => {
        if (world.failing) throw new Error("the cloud could not be reached");
        return { hosts: [] };
      },
      "environment.list": () => ({
        environments: [
          {
            environmentId: "env-a",
            ownerKind: "organization" as const,
            ownerId: "team-a",
            roomId: "room-a",
            label: "Acme",
            effectiveRole: "editor" as const,
            kind: "team" as const,
            hostCount: 1,
            providerHandle: "handle-a",
          },
        ],
      }),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Couldn't read Acme's hosts.")).toBeTruthy();
    // An unread inventory is not an empty one: it cannot say a sandbox is
    // what the reader needs.
    expect(screen.queryByText(/sandbox to see/)).toBeNull();
    expect(screen.queryByText(/Live values need a host running/)).toBeNull();

    world.failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByText(/Live values need a host running/),
    ).toBeTruthy();
  });
});

describe("Environment page subtitles", () => {
  const environments = {
    environments: [
      {
        environmentId: "env-a",
        ownerKind: "organization" as const,
        ownerId: "team-a",
        roomId: "room-a",
        label: "Acme",
        effectiveRole: "editor" as const,
        kind: "team" as const,
        hostCount: 1,
        providerHandle: "handle-a",
      },
      {
        environmentId: "env-personal",
        ownerKind: "user" as const,
        ownerId: "user-me",
        roomId: "room-personal",
        label: "Personal",
        effectiveRole: "owner" as const,
        kind: "personal" as const,
        hostCount: 1,
        providerHandle: null,
      },
    ],
  };
  const handlers = {
    "environment.list": () => environments,
    "environment.configuration.items": () => ({ items: [] }),
    "environment.host.list": () => ({ hosts: [] }),
    "environment.plans.list": () => ({ plans: [] }),
    "environment.members": () => ({
      members: [],
      nextCursor: null,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    }),
  } as const;

  it.each([
    {
      pageName: "Providers",
      page: <TeamProviders key="p" />,
      team: "Sign-ins, keys and tools for each coding agent.",
      personal: "Sign-ins, keys and tools for each coding agent.",
      teamSplit: false,
      personalSplit: false,
    },
    {
      pageName: "Skills",
      page: <TeamSkillsPage key="s" />,
      team: "Instructions agents follow for a kind of task. Acme's skills reach every provider on its hosts.",
      personal:
        "Instructions agents follow for a kind of task. Personal's skills reach every provider on every computer and sandbox running Personal.",
      teamSplit: true,
      personalSplit: false,
    },
    {
      pageName: "Permissions",
      page: <TeamPermissions key="x">{null}</TeamPermissions>,
      team: "What agents may do without asking, on every host running Acme.",
      personal:
        "What your agents may do without asking, on every computer and sandbox running Personal.",
      teamSplit: false,
      personalSplit: false,
    },
    {
      pageName: "Variables & shells",
      page: <TeamVariablesAndShells key="v" />,
      team: "Plain values every host running Acme gets, and the shell agents run in.",
      personal:
        "Plain values every computer and sandbox running Personal gets, and the shell agents run in.",
      teamSplit: true,
      personalSplit: false,
    },
  ])(
    "$pageName names its configuration",
    async ({ page, team, personal, teamSplit, personalSplit }) => {
      const teamHarness = mountTeamPage(poolSource("editor"), handlers);
      render(page, { wrapper: teamHarness.Wrapper });
      await expectSentence(team, "Acme", teamSplit);
      cleanup();
      resetTeamPageHarness();
      const harness = mountTeamPage(personalPoolSource(), handlers);
      render(page, { wrapper: harness.Wrapper });
      await expectSentence(personal, "Personal", personalSplit);
    },
  );

  it.each([
    {
      pageTitle: "Skills",
      section: "skills",
      page: <TeamSkillsPage key="skills" />,
      source: poolSource("editor"),
      pick: { kind: "team", environmentId: "env-a" },
      environmentName: "Acme",
      sentence:
        "Instructions agents follow for a kind of task. Acme's skills reach every provider on its hosts.",
      split: true,
    },
    {
      pageTitle: "Skills",
      section: "skills",
      page: <TeamSkillsPage key="skills-personal" />,
      source: personalPoolSource(),
      pick: { kind: "personal" },
      environmentName: "Personal",
      sentence:
        "Instructions agents follow for a kind of task. Personal's skills reach every provider on every computer and sandbox running Personal.",
      split: false,
    },
    {
      pageTitle: "Permissions",
      section: "permissions",
      page: <TeamPermissions key="permissions">{null}</TeamPermissions>,
      source: poolSource("editor"),
      pick: { kind: "team", environmentId: "env-a" },
      environmentName: "Acme",
      sentence:
        "What agents may do without asking, on every host running Acme.",
      split: false,
    },
    {
      pageTitle: "Variables & shells",
      section: "shell",
      page: <TeamVariablesAndShells key="variables-shells" />,
      source: poolSource("editor"),
      pick: { kind: "team", environmentId: "env-a" },
      environmentName: "Acme",
      sentence:
        "Plain values every host running Acme gets, and the shell agents run in.",
      split: true,
    },
  ] as const)(
    "$pageTitle · $environmentName shows its environment once in the phone caption",
    async ({
      pageTitle,
      section,
      page,
      source,
      pick,
      environmentName,
      sentence,
      split,
    }) => {
      useSettingsEnvironmentPickStore.setState({
        pick,
      });
      setPhoneLayoutOnly(true);
      const harness = mountTeamPage(source, handlers);
      render(
        <SettingsSectionContext value={section}>{page}</SettingsSectionContext>,
        { wrapper: harness.Wrapper },
      );

      const scopeLine = await screen.findByTestId("settings-phone-scope-line");
      await waitFor(() => {
        expect(scopeLine.textContent).toBe(environmentName);
        expect(pageDescription().textContent).toBe(sentence);
      });
      if (split) {
        const nameNode = within(pageDescription()).getByText(environmentName);
        expect(nameNode.tagName).toBe("SPAN");
        expect(nameNode.className).toContain("truncate");
      }
      const heading = screen.getByRole("heading", {
        level: 1,
        name: pageTitle,
      });
      const header = heading.closest("header");
      if (header === null) throw new Error("page heading has no header");
      const namePattern = new RegExp(environmentName, "g");
      const descriptionCount =
        pageDescription().textContent.match(namePattern)?.length ?? 0;
      const headerCount = header.textContent.match(namePattern)?.length ?? 0;
      expect(headerCount - descriptionCount).toBe(1);
    },
  );
});

describe("A cloud page's failed read", () => {
  const environments = {
    environments: [
      {
        environmentId: "env-a",
        ownerKind: "organization" as const,
        ownerId: "team-a",
        roomId: "room-a",
        label: "Acme",
        effectiveRole: "admin" as const,
        kind: "team" as const,
        hostCount: 1,
        providerHandle: "handle-a",
      },
      {
        environmentId: "env-personal",
        ownerKind: "user" as const,
        ownerId: "user-me",
        roomId: "room-personal",
        label: "Me",
        effectiveRole: "owner" as const,
        kind: "personal" as const,
        hostCount: 1,
        providerHandle: null,
      },
    ],
  };
  const failingHandlers = {
    "environment.list": () => environments,
    "environment.configuration.items": () => {
      throw new Error("host unavailable");
    },
    "environment.host.list": () => ({ hosts: [] }),
    "environment.plans.list": () => ({ plans: [] }),
    "environment.members": () => ({
      members: [],
      nextCursor: null,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    }),
  } as const;

  it.each([
    ["a team", poolSource("editor"), "Acme"],
    ["Personal", personalPoolSource(), "Personal"],
  ])(
    "names %s and the page, and Retry reads again",
    async (_name, source, who) => {
      const harness = mountTeamPage(source, failingHandlers);
      render(<TeamProviders />, { wrapper: harness.Wrapper });

      const failure = await screen.findByText(
        `Couldn't read ${who}'s providers.`,
      );
      const reads = harness.paramsOf("environment.configuration.items").length;
      await userEvent.click(
        within(failure.closest("p") ?? failure).getByRole("button", {
          name: "Retry",
        }),
      );

      await waitFor(() => {
        expect(
          harness.paramsOf("environment.configuration.items").length,
        ).toBeGreaterThan(reads);
      });
    },
  );

  it("names the team on the Browser agent access row, and Retry reads again", async () => {
    const harness = mountTeamPage(poolSource("editor"), failingHandlers);
    render(<BrowserAgentAccessGroup />, { wrapper: harness.Wrapper });

    const failure = await screen.findByText(
      "Couldn't read Acme's browser agent access.",
    );
    const reads = harness.paramsOf("environment.configuration.items").length;
    await userEvent.click(
      within(failure.closest("p") ?? failure).getByRole("button", {
        name: "Retry",
      }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(reads);
    });
  });
});
