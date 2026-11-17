import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PushPermissionState,
  PushRegistrationState,
  PushSeverity,
} from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { doubleFor } from "@/components/settings/panels/__tests__/push-permission-double";
import { useNotificationNotifies } from "@/hooks/notifications/use-notification-notifies";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

beforeEach(() => {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-1", userName: "user-1", email: "u@example.com" },
      { userId: "user-1", username: "user-1" },
      [],
    );
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

function notifiesOnPhone(cache: {
  readonly permission: PushPermissionState;
  readonly registration: PushRegistrationState;
  readonly muted: readonly PushSeverity[] | null;
}) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(runnerQueryKeys.pushPermission(), {
    permission: cache.permission,
    registration: cache.registration,
  });
  if (cache.muted !== null) {
    queryClient.setQueryData(
      runnerQueryKeys.pushMutedSeverities("user-1"),
      cache.muted,
    );
  }
  const runnerHost = createFakeRunnerHost({
    pushPermission: doubleFor("granted").host,
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        {props.children}
      </RunnerHostProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useNotificationNotifies(), { wrapper }).result
    .current;
}

describe("useNotificationNotifies", () => {
  it("follows the store's Notify switches on a computer", () => {
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={new QueryClient()}>
        <RunnerHostProvider runnerHost={createFakeRunnerHost({})}>
          {props.children}
        </RunnerHostProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useNotificationNotifies(), {
      wrapper,
    });

    expect(result.current("failure")).toBe(true);
    expect(result.current("info")).toBe(false);

    useSettingsStore.getState().setNotificationNotifyForEvent("failure", false);
    useSettingsStore.getState().setNotificationNotifyForEvent("info", true);

    expect(result.current("failure")).toBe(false);
    expect(result.current("info")).toBe(true);
  });

  it("refuses only the muted kinds once push is granted and registered", () => {
    const notifies = notifiesOnPhone({
      permission: "granted",
      registration: "registered",
      muted: ["failure"],
    });

    expect(notifies("failure")).toBe(false);
    expect(notifies("needs_action")).toBe(true);
    expect(notifies("done")).toBe(true);
  });

  it.each<[string, PushPermissionState, PushRegistrationState]>([
    ["is not granted", "denied", "registered"],
    ["is still registering", "granted", "pending"],
  ])(
    "lets every kind through while push %s",
    (_name, permission, registration) => {
      const notifies = notifiesOnPhone({
        permission,
        registration,
        muted: ["failure"],
      });

      expect(notifies("failure")).toBe(true);
    },
  );

  it("lets every kind through before the muted set has been read", () => {
    const notifies = notifiesOnPhone({
      permission: "granted",
      registration: "registered",
      muted: null,
    });

    expect(notifies("failure")).toBe(true);
  });

  it("ignores the computer's Notify switches: Info off in the store still shows on a phone", () => {
    expect(useSettingsStore.getState().notificationNotify.info).toBe(false);

    const notifies = notifiesOnPhone({
      permission: "granted",
      registration: "registered",
      muted: [],
    });

    expect(notifies("info")).toBe(true);
  });

  it("reads the signed-in account's muted set, not another account's", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(runnerQueryKeys.pushPermission(), {
      permission: "granted",
      registration: "registered",
    });
    queryClient.setQueryData(runnerQueryKeys.pushMutedSeverities("user-2"), [
      "failure",
    ]);
    const runnerHost = createFakeRunnerHost({
      pushPermission: doubleFor("granted").host,
    });
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          {props.children}
        </RunnerHostProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useNotificationNotifies(), {
      wrapper,
    });

    expect(result.current("failure")).toBe(true);
  });
});
