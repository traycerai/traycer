import { render, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  admitCurrentUserToTeamWindow,
  type TeamPageHarness,
} from "./team-configuration-test-support";

export async function renderAdmittedTeamPage(
  harness: TeamPageHarness,
): Promise<void> {
  await waitFor(() => {
    expect(useAuthStore.getState().contextMetadata?.userId).toBe(
      "team-test-user",
    );
  });
  admitCurrentUserToTeamWindow();
  render(<TeamProviders />, { wrapper: harness.Wrapper });
}
