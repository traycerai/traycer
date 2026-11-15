import "./team-provider-profiles-test-support";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { describe, expect, it } from "vitest";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  admitCurrentUserToTeamWindow,
  mountTeamPageThroughBoundary,
  recordAppLoggerCalls,
  teamProfileRecord,
  teamProfileRecordsBody,
  teamProfileRecordHttpBoundary,
  teamProfileRecordReadCount,
  teamPageCachedErrorValues,
} from "./team-configuration-test-support";
import { reachableHost } from "./mcp-skills-test-support";
import {
  openProfileEditor,
  handlers,
  claudeLoginProviderRow,
} from "./team-providers-test-support";

const ACTION_REFUSALS = [
  {
    action: "remove",
    status: 403,
    code: "environment_action_forbidden",
    message: "You don't have permission to do that.",
  },
  {
    action: "sign-out",
    status: 403,
    code: "environment_action_forbidden",
    message: "You don't have permission to do that.",
  },
  {
    action: "rename",
    status: 403,
    code: "environment_action_forbidden",
    message: "You don't have permission to do that.",
  },
  {
    action: "remove",
    status: 404,
    code: "environment_not_found",
    message: "Couldn't remove profile.",
  },
  {
    action: "sign-out",
    status: 404,
    code: "environment_not_found",
    message: "Couldn't sign out.",
  },
  {
    action: "rename",
    status: 404,
    code: "environment_not_found",
    message: "Couldn't rename profile.",
  },
] as const;

const ACTION_SERVER_ERROR_CANARY = "synthetic-action-server-detail";

describe("Team Providers direct action refusals", () => {
  it.each(ACTION_REFUSALS)(
    "shows fixed $action copy for authn $status through the real page",
    async ({ action, status, code, message }) => {
      const profileId = `team-action-${action}`;
      const profileName = `Team ${action} profile`;
      teamProfileRecordHttpBoundary.list = {
        status: 200,
        body: teamProfileRecordsBody([
          teamProfileRecord({
            profileId,
            harnessId: "claude",
            name: profileName,
            readerLabel: "live",
            kind: "oauth_code",
          }),
        ]),
      };
      teamProfileRecordHttpBoundary.action = {
        status,
        body: {
          statusCode: status,
          error: ACTION_SERVER_ERROR_CANARY,
          code,
        },
      };
      const harness = mountTeamPageThroughBoundary(
        "admin",
        {
          ...handlers(() => []),
          "environment.host.list": () => ({ hosts: [reachableHost] }),
          "providers.list": () => ({
            providers: [claudeLoginProviderRow()],
            native: null,
          }),
        },
        "providers",
      );
      await waitFor(() => {
        expect(useAuthStore.getState().contextMetadata?.userId).toBe(
          "team-test-user",
        );
      });
      admitCurrentUserToTeamWindow();
      render(<TeamProviders />, { wrapper: harness.Wrapper });

      await screen.findByRole("button", {
        name: `Claude Code profile: ${profileName}`,
      });
      const editor = await openProfileEditor();
      const appLogs = recordAppLoggerCalls();
      if (action === "remove") {
        await userEvent.click(
          within(editor).getByRole("button", { name: "Remove profile" }),
        );
        const confirmation = await screen.findByRole("dialog", {
          name: `Remove ${profileName}?`,
        });
        await userEvent.click(
          within(confirmation).getByRole("button", { name: "Remove" }),
        );
      } else if (action === "sign-out") {
        await userEvent.click(
          within(editor).getByRole("button", { name: "Sign out" }),
        );
        const confirmation = await screen.findByRole("dialog", {
          name: `Sign out of ${profileName} in Acme?`,
        });
        await userEvent.click(
          within(confirmation).getByRole("button", { name: "Sign out" }),
        );
      } else {
        fireEvent.change(within(editor).getByLabelText("Profile name"), {
          target: { value: `Renamed ${profileName}` },
        });
        await userEvent.click(
          within(editor).getByRole("button", { name: "Save changes" }),
        );
      }

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(message);
        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(teamProfileRecordReadCount()).toBe(2);
      });
      expect(screen.getByRole("dialog")).toBeTruthy();
      const pathAction = action === "rename" ? "name" : action;
      const requests = teamProfileRecordHttpBoundary.calls.filter(
        (call) =>
          call.method === "POST" &&
          new URL(call.url).pathname.endsWith(
            `/profile-records/${profileId}/${pathAction}`,
          ),
      );
      expect(requests).toHaveLength(1);
      const observableOutput = JSON.stringify({
        text: document.body.textContent,
        cachedErrors: teamPageCachedErrorValues(harness),
        logs: appLogs(),
      });
      expect(observableOutput.includes(ACTION_SERVER_ERROR_CANARY)).toBe(false);
    },
  );
});
