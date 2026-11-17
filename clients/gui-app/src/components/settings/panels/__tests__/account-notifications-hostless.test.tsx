import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountNotificationSettingsResponse } from "@traycer-clients/shared/environment/account-notification-schemas";
import { NEEDS_CONNECTION_MESSAGE } from "@traycer-clients/shared/environment/environment-cloud";
import { authSessionForUser } from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { NotificationsSettingsPanel } from "@/components/settings/panels/notifications-settings-panel";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { HostRuntimeTestProvider } from "@/lib/host/__tests__/host-runtime-test-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

const SETTINGS_PATH = "/api/v3/user/notification-settings";

const storedMatrix = {
  needs_action: { renderer: true },
  failure: { renderer: false },
  done: { renderer: false },
  info: { renderer: true },
};

const storedHook = {
  id: "build-alerts",
  name: "Build alerts",
  enabled: true,
  severities: null,
  action: {
    type: "http" as const,
    url: "https://hooks.example/builds",
    headers: {},
  },
  held: false,
};

const accountResponse: AccountNotificationSettingsResponse = {
  revision: 7,
  settings: { matrix: storedMatrix, hooks: [storedHook] },
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
  it("renders the account's hooks from one account read", async () => {
    const sent = stubAuthn();
    await renderHostless("signed-in");

    const manager = await screen.findByTestId(
      "cloud-notification-hooks-manager",
    );
    expect(within(manager).getByText("Build alerts")).toBeTruthy();
    expect(sent).toEqual([{ method: "GET", path: SETTINGS_PATH, body: null }]);
  });

  it("shows the plain needs-connection text and fetches nothing while unverified (store set to unverified after the real sign-in)", async () => {
    const sent = stubAuthn();
    await renderHostless("unverified");

    expect(
      await screen.findByText(NEEDS_CONNECTION_MESSAGE.settings),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("cloud-notification-hooks-manager")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("saves a hook to authn once, with no host in the path and no matrix in the body", async () => {
    const sent = stubAuthn();
    await renderHostless("signed-in");
    const manager = await screen.findByTestId(
      "cloud-notification-hooks-manager",
    );
    fireEvent.click(within(manager).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Build alerts revised" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Save hook" }));

    // The hooks body is the whole write: authn leaves the stored matrix as it is.
    await waitFor(() =>
      expect(sent.filter((request) => request.method === "PUT")).toEqual([
        {
          method: "PUT",
          path: SETTINGS_PATH,
          body: {
            hooks: [{ ...storedHook, name: "Build alerts revised" }],
            revision: 7,
          },
        },
      ]),
    );
  });
});
