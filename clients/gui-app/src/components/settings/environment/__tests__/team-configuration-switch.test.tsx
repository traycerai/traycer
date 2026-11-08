import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import {
  ConfigurationSourceContext,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
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
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

const variable = (value: string): EnvironmentConfigurationItem =>
  configurationItem({
    kind: "variable",
    key: "NODE_ENV",
    os: "any",
    value: { value },
    revision: 3,
  });

function teamSource(environmentId: string): ConfigurationSource {
  const source = poolSource("editor");
  if (source.kind !== "pool") throw new Error("poolSource reads the pool");
  return { ...source, environmentId };
}

describe("Variables and shells moving between two teams", () => {
  it("never shows one team's unsaved edit in the other, whose variable shares the name and revision", async () => {
    const valueOf: Record<string, string> = {
      "env-a": "production",
      "env-b": "staging",
    };
    const harness = mountTeamPage(teamSource("env-a"), {
      "environment.configuration.items": (request) => ({
        items: [variable(valueOf[request.environmentId] ?? "")],
      }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    // Both teams' reads stay cached, so no pending read unmounts the rows:
    // only the page's key can drop a draft.
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, gcTime: Infinity },
    });
    // A fresh element each time: React skips re-rendering an identical one.
    const page = (environmentId: string): ReactNode => (
      <QueryClientProvider client={harness.queryClient}>
        <ConfigurationSourceContext.Provider value={teamSource(environmentId)}>
          <ShellSettingsPanel />
        </ConfigurationSourceContext.Provider>
      </QueryClientProvider>
    );
    const view = render(page("env-a"));
    const field = (): HTMLInputElement => {
      const input = screen.getByLabelText("NODE_ENV value");
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("NODE_ENV value is not an input");
      }
      return input;
    };
    await waitFor(() => {
      expect(field().value).toBe("production");
    });
    fireEvent.change(field(), { target: { value: "a draft nobody saved" } });

    view.rerender(page("env-b"));
    await waitFor(() => {
      expect(field().value).toBe("staging");
    });

    view.rerender(page("env-a"));
    await waitFor(() => {
      expect(field().value).toBe("production");
    });
  });
});
