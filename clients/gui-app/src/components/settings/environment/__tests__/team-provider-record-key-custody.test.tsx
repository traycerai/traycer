import "./team-provider-profiles-test-support";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  admitCurrentUserToTeamWindow,
  mountTeamPageThroughBoundary,
  teamProfileRecordHttpBoundary,
  teamProfileRecordsBody,
  type TeamBoundaryPageHarness,
} from "./team-configuration-test-support";
import { negotiateMethods, reachableHost } from "./mcp-skills-test-support";
import { cursorProviderListRow, handlers } from "./team-providers-test-support";

const CUSTODY_WITH_SANDBOXES =
  "Stored encrypted in Traycer's cloud. Computers running Acme receive the value, readable by their tools and agents; sandboxes use it without seeing it.";
const CUSTODY_WITHOUT_SANDBOXES =
  "Stored encrypted in Traycer's cloud. Computers running Acme receive the value, readable by their tools and agents.";

function keyProviderRow(
  providerId: "cursor" | "kiro",
  recordEnvironmentId: string | null | undefined,
): ProviderCliState {
  return {
    ...cursorProviderListRow(),
    providerId,
    apiKey: {
      supported: true,
      configured: false,
      source: null,
      ...(recordEnvironmentId === undefined ? {} : { recordEnvironmentId }),
    },
  };
}

async function renderKeyFieldFor(
  providerName: "Cursor" | "Kiro",
  row: ProviderCliState,
): Promise<TeamBoundaryPageHarness> {
  teamProfileRecordHttpBoundary.list = {
    status: 200,
    body: teamProfileRecordsBody([]),
  };
  const harness = mountTeamPageThroughBoundary(
    "admin",
    {
      ...handlers(() => []),
      "environment.host.list": () => ({ hosts: [reachableHost] }),
      "providers.list": () => ({ providers: [row], native: null }),
    },
    "providers",
  );
  negotiateMethods({ "providers.list": { major: 10, minor: 13 } });
  await waitFor(() => {
    expect(useAuthStore.getState().contextMetadata?.userId).toBe(
      "team-test-user",
    );
  });
  admitCurrentUserToTeamWindow();
  render(<TeamProviders />, { wrapper: harness.Wrapper });
  await userEvent.click(
    await screen.findByRole("button", {
      name: new RegExp(`^${providerName}`),
    }),
  );
  await screen.findByLabelText("API key");
  return harness;
}

async function windowHostAnswered(
  harness: TeamBoundaryPageHarness,
): Promise<void> {
  await waitFor(() => {
    expect(
      harness.queryClient
        .getQueryCache()
        .getAll()
        .some(
          (query) =>
            query.queryKey.includes("providers.list") &&
            query.state.status === "success",
        ),
    ).toBe(true);
  });
}

describe("Team Providers key field custody line", () => {
  it.each([
    {
      providerName: "Cursor",
      providerId: "cursor",
      line: CUSTODY_WITH_SANDBOXES,
    },
    {
      providerName: "Kiro",
      providerId: "kiro",
      line: CUSTODY_WITHOUT_SANDBOXES,
    },
  ] as const)(
    "says where a $providerName key goes when the window's computer runs this team's record",
    async ({ providerName, providerId, line }) => {
      await renderKeyFieldFor(
        providerName,
        keyProviderRow(providerId, "env-a"),
      );

      await waitFor(() => expect(screen.getByText(line)).toBeTruthy());
      expect(screen.queryByText("How Traycer handles this")).toBeNull();
    },
  );

  it.each([
    { label: "an older computer", recordEnvironmentId: undefined },
    { label: "record mode off", recordEnvironmentId: null },
    {
      label: "a computer running another environment",
      recordEnvironmentId: "env-b",
    },
  ] as const)(
    "draws no custody line for $label",
    async ({ recordEnvironmentId }) => {
      const harness = await renderKeyFieldFor(
        "Cursor",
        keyProviderRow("cursor", recordEnvironmentId),
      );
      await windowHostAnswered(harness);

      expect(
        screen.queryByText(/^Stored encrypted in Traycer's cloud\./),
      ).toBeNull();
    },
  );
});
