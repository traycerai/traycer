import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_NOTIFICATION_MATRIX,
  type AccountNotificationSettingsResponse,
} from "@traycer-clients/shared/environment/account-notification-schemas";
import { NEEDS_CONNECTION_MESSAGE } from "@traycer-clients/shared/environment/environment-cloud";
import { authSessionForUser } from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { NotificationsSettingsPanel } from "@/components/settings/panels/notifications-settings-panel";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { HostRuntimeTestProvider } from "@/lib/host/__tests__/host-runtime-test-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

const SETTINGS_PATH = "/api/v3/user/notification-settings";

const SEVERITIES = ["needs_action", "failure", "done", "info"] as const;

const accountResponse: AccountNotificationSettingsResponse = {
  revision: 7,
  settings: { matrix: DEFAULT_ACCOUNT_NOTIFICATION_MATRIX, hooks: [] },
};

interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function stubAuthn(): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    sent.push({
      method,
      path,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    if (path !== SETTINGS_PATH)
      return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(accountResponse), { status: 200 }),
    );
  });
  return sent;
}

function PublishedAuth(props: {
  readonly onAuth: (auth: AuthService) => void;
}): null {
  const binding = useHostBinding();
  const { onAuth } = props;
  useEffect(() => {
    if (binding !== null) onAuth(binding.auth);
  }, [binding, onAuth]);
  return null;
}

/** The panel under the app's real host runtime with no host, signed in through its real AuthService. */
async function renderHostless(
  status: "signed-in" | "unverified",
): Promise<void> {
  const published: { auth: AuthService | null } = { auth: null };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HostRuntimeTestProvider>
        <PublishedAuth
          onAuth={(auth) => {
            published.auth = auth;
          }}
        />
        <NotificationsSettingsPanel />
      </HostRuntimeTestProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(published.auth).not.toBeNull());
  const auth = published.auth;
  if (auth === null) throw new Error("The host runtime published no binding.");
  act(() => {
    auth.applyExternalSession(authSessionForUser("user-1", "token-1"));
    if (status === "unverified")
      useAuthStore.setState({ status: "unverified" });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAuthStore.setState({ status: "signed-out" });
});

describe("account notification settings with no computer connected", () => {
  it("renders every severity switch from the account read", async () => {
    const sent = stubAuthn();
    await renderHostless("signed-in");

    for (const severity of SEVERITIES)
      expect(
        await screen.findByTestId(`notifications-severity-${severity}`),
      ).toBeTruthy();
    expect(sent).toEqual([{ method: "GET", path: SETTINGS_PATH, body: null }]);
  });

  it("shows the plain needs-connection text and fetches nothing while unverified (store set to unverified after the real sign-in)", async () => {
    const sent = stubAuthn();
    await renderHostless("unverified");

    expect(
      await screen.findByText(NEEDS_CONNECTION_MESSAGE.settings),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("notifications-severity-done")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("saves a switch to authn once", async () => {
    const sent = stubAuthn();
    await renderHostless("signed-in");
    const done = await screen.findByTestId("notifications-severity-done");
    await waitFor(() => expect(done).toHaveProperty("disabled", false));

    fireEvent.click(done);

    await waitFor(() =>
      expect(sent.filter((request) => request.method === "PUT")).toEqual([
        {
          method: "PUT",
          path: SETTINGS_PATH,
          body: {
            matrix: {
              ...DEFAULT_ACCOUNT_NOTIFICATION_MATRIX,
              done: {
                renderer: !DEFAULT_ACCOUNT_NOTIFICATION_MATRIX.done.renderer,
              },
            },
            revision: 7,
          },
        },
      ]),
    );
  });
});
