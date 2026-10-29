import "../../../../../__tests__/test-browser-apis";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import { ReplaceSecretValueDialog } from "@/components/settings/secrets/replace-secret-value-dialog";
import type { HostRpcRegistry } from "@/lib/host";
import { SECRET_CUSTODY_SENTENCE } from "@/lib/sandboxes/secrets-page-copy";
import { teamEnvironments } from "@/components/settings/environment/__tests__/mcp-skills-test-support";
import {
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

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

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
});

const HANDLERS: MockHandlerMap<HostRpcRegistry> = {
  "environment.list": () => teamEnvironments,
};

const SECRET: EnvironmentSecret = {
  secretId: "secret-a",
  name: "secret-a",
  kind: "api_key",
  protocol: null,
  destinations: ["api.acme.test:443"],
  mode: "brokered",
  state: "live",
  currentVersionId: "v1",
  revoked: false,
  updatedAt: 1,
};

describe("Replace value's custody sentence", () => {
  it("reads the team form on Acme's configuration", async () => {
    const harness = mountTeamPage(poolSource("editor"), HANDLERS);
    render(
      <ReplaceSecretValueDialog
        open
        secret={SECRET}
        client={requireTeamHostClient()}
        onOpenChange={() => undefined}
        onReplaced={() => undefined}
      />,
      { wrapper: harness.Wrapper },
    );
    await waitFor(() => {
      expect(screen.getByTestId("secret-replace-custody").textContent).toBe(
        "Stored encrypted in Traycer's cloud. Acme's sandboxes and connected services use it without seeing it; no computer receives the value.",
      );
    });
  });

  it("keeps Personal's own sentence on Personal's configuration", () => {
    const harness = mountTeamPage(personalPoolSource(), HANDLERS);
    render(
      <ReplaceSecretValueDialog
        open
        secret={SECRET}
        client={requireTeamHostClient()}
        onOpenChange={() => undefined}
        onReplaced={() => undefined}
      />,
      { wrapper: harness.Wrapper },
    );
    expect(screen.getByTestId("secret-replace-custody").textContent).toBe(
      SECRET_CUSTODY_SENTENCE,
    );
  });

  it("keeps Personal's own sentence in host mode, with no cloud configuration source", () => {
    const harness = mountTeamPage(poolSource("editor"), HANDLERS);
    render(
      <QueryClientProvider client={harness.queryClient}>
        <ReplaceSecretValueDialog
          open
          secret={SECRET}
          client={requireTeamHostClient()}
          onOpenChange={() => undefined}
          onReplaced={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("secret-replace-custody").textContent).toBe(
      SECRET_CUSTODY_SENTENCE,
    );
  });
});
