import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDefinitionsTab } from "@/components/settings/panels/agent-definitions-tab";
import { BrowserAgentAccessGroup } from "@/components/settings/panels/browser-agent-access-group";
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
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
// The window's host directory and handshake are the external boundaries: the
// host serves every method these pages ask about.
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-local",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostSupportsMethod: () => true,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ label: "This computer" }),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

const definition = (text: string, revision: number) =>
  configurationItem({
    kind: "agent_definition",
    key: "reviewer",
    value: { text },
    revision,
  });

describe("AgentDefinitionsTab on a team", () => {
  it("reads the team's definitions from the pool items, not the host's list", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [definition("Review the diff", 7)],
      }),
    });
    render(<AgentDefinitionsTab />, { wrapper: harness.Wrapper });

    expect((await screen.findByLabelText("reviewer text")).textContent).toBe(
      "Review the diff",
    );
    expect(harness.paramsOf("environment.configuration.items")[0]).toEqual({
      environmentId: "env-a",
    });
    expect(harness.paramsOf("environment.agentDefinitions.list")).toHaveLength(
      0,
    );
  });

  it("keeps the host path on the host's own definitions list", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.agentDefinitions.list": () => ({
          definitions: [{ name: "reviewer", text: "Own text", revision: 2 }],
        }),
      },
    );
    render(<AgentDefinitionsTab />, { wrapper: harness.Wrapper });

    expect((await screen.findByLabelText("reviewer text")).textContent).toBe(
      "Own text",
    );
    expect(harness.paramsOf("environment.configuration.items")).toHaveLength(0);
  });

  it("gives a viewer read-only text with no Save, Delete or New verbs", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.configuration.items": () => ({
        items: [definition("Review the diff", 7)],
      }),
    });
    render(<AgentDefinitionsTab />, { wrapper: harness.Wrapper });

    const field = await screen.findByLabelText("reviewer text");
    expect(field).toHaveProperty("readOnly", true);
    for (const verb of ["Save", "Delete", "Add"]) {
      expect(
        screen.queryByRole("button", { name: new RegExp(verb) }),
      ).toBeNull();
    }
    expect(screen.queryByLabelText("Agent definition name")).toBeNull();
  });

  it("saves against the displayed revision, and a conflict rereads the current text beside the changed-by line", async () => {
    let current = definition("Review the diff", 7);
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [current] }),
      "environment.configuration.items.put": () => {
        current = definition("Review for security", 8);
        return {
          outcome: "conflict",
          current: { revision: 8, changedBy: "Grace", changedAt: 2 },
        };
      },
    });
    render(<AgentDefinitionsTab />, { wrapper: harness.Wrapper });

    const field = await screen.findByLabelText("reviewer text");
    await userEvent.clear(field);
    await userEvent.type(field, "Mine");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "agent_definition",
        key: "reviewer",
        os: null,
        value: { text: "Mine" },
        revision: 7,
      },
    ]);
    expect(
      await screen.findByText("Changed by Grace a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByLabelText("reviewer text").textContent).toBe(
        "Review for security",
      );
    });
  });
});

describe("BrowserAgentAccessGroup on a team", () => {
  const access = (enabled: boolean, revision: number) =>
    configurationItem({
      kind: "browser_agent_access",
      key: "browser",
      value: { enabled },
      revision,
    });

  it("lets an admin flip the switch against the displayed revision", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.configuration.items": () => ({ items: [access(true, 4)] }),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 5,
      }),
    });
    render(<BrowserAgentAccessGroup />, { wrapper: harness.Wrapper });

    const toggle = await screen.findByRole("switch", {
      name: "Let agents use the in-app browser",
    });
    await waitFor(() => {
      expect(toggle).toHaveProperty("ariaChecked", "true");
    });
    await userEvent.click(toggle);

    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "browser_agent_access",
        key: "browser",
        os: null,
        value: { enabled: false },
        revision: 4,
      },
    ]);
    expect(harness.paramsOf("config.browser.get")).toHaveLength(0);
  });

  it("shows an editor the setting without a switch", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [access(true, 4)] }),
    });
    render(<BrowserAgentAccessGroup />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("reads an absent row as on, and the first flip creates it with a null revision", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.configuration.items": () => ({ items: [] }),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 1,
      }),
    });
    render(<BrowserAgentAccessGroup />, { wrapper: harness.Wrapper });

    const toggle = await screen.findByRole("switch", {
      name: "Let agents use the in-app browser",
    });
    await waitFor(() => {
      expect(toggle).toHaveProperty("disabled", false);
    });
    await userEvent.click(toggle);
    expect(
      harness.paramsOf("environment.configuration.items.put")[0],
    ).toMatchObject({ value: { enabled: false }, revision: null });
  });

  it("rereads the current value and names who changed it after a conflict", async () => {
    let current = access(true, 4);
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.configuration.items": () => ({ items: [current] }),
      "environment.configuration.items.put": () => {
        current = access(true, 5);
        return {
          outcome: "conflict",
          current: { revision: 5, changedBy: "Grace", changedAt: 2 },
        };
      },
    });
    render(<BrowserAgentAccessGroup />, { wrapper: harness.Wrapper });

    const toggle = await screen.findByRole("switch", {
      name: "Let agents use the in-app browser",
    });
    await waitFor(() => {
      expect(toggle).toHaveProperty("ariaChecked", "true");
    });
    await userEvent.click(toggle);

    expect(
      await screen.findByText("Changed by Grace a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items").length).toBe(
        2,
      );
    });
    expect(
      screen.getByRole("switch", { name: "Let agents use the in-app browser" }),
    ).toHaveProperty("ariaChecked", "true");
  });

  it("keeps the host path on the host's own browser config", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      { "config.browser.get": () => ({ agentAccess: true }) },
    );
    render(<BrowserAgentAccessGroup />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(harness.paramsOf("config.browser.get").length).toBeGreaterThan(0);
    });
    expect(harness.paramsOf("environment.configuration.items")).toHaveLength(0);
  });
});
