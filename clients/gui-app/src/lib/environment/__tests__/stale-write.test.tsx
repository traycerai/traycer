import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => {
  // `toast` is callable as well as a namespace (the transport notice uses the
  // plain call), so a namespace-only mock would throw rather than fail an
  // assertion.
  const base = vi.fn();
  return {
    toast: Object.assign(base, {
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
    }),
  };
});

import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { EnvironmentStaleWrite } from "@traycer/protocol/framework/environment-stale-write";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useRereadOnStaleWrite } from "@/hooks/environment/use-reread-on-stale-write";
import { staleWriteMessage, staleWriteOf } from "@/lib/environment/stale-write";
import {
  toastFromHostError,
  toastFromHostErrorWithDetail,
} from "@/lib/host-error-toast";
import { queryKeys } from "@/lib/query-keys";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";

const DASHBOARD: EnvironmentStaleWrite = {
  changedBy: { kind: "dashboard" },
  currentRevision: 7,
};

function changedOnHost(hostLabel: string | null): EnvironmentStaleWrite {
  return {
    changedBy: { kind: "host", hostId: "host-b", hostLabel },
    currentRevision: 8,
  };
}

/** The error the wire produces for a stale save: built from the envelope. */
function staleError(staleWrite: EnvironmentStaleWrite): HostRpcError {
  return HostRpcError.fromWireEnvelope(
    {
      code: "ENVIRONMENT_WRITE_STALE",
      message: "The setting changed since it was read.",
      staleWrite,
    },
    "req-stale",
    "config.env.set",
  );
}

function plainError(code: HostRpcError["code"]): HostRpcError {
  return new HostRpcError({
    code,
    message: "something else went wrong",
    requestId: "req-other",
    method: "config.env.set",
    fatalDetails: null,
  });
}

afterEach(() => {
  cleanup();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast).mockClear();
  __resetAppLocalNotificationsStoreForTests();
});

describe("staleWriteMessage", () => {
  it("says the dashboard changed the setting", () => {
    expect(staleWriteMessage(DASHBOARD)).toBe(
      "This setting was changed in the dashboard just now.",
    );
  });

  it("names the host that changed it", () => {
    expect(staleWriteMessage(changedOnHost("dev-box"))).toBe(
      "This setting was changed on dev-box just now.",
    );
  });

  it("says another host when the changing host has no label", () => {
    expect(staleWriteMessage(changedOnHost(null))).toBe(
      "This setting was changed on another host just now.",
    );
  });

  it("leaves markup in a host label as literal text", () => {
    const message = staleWriteMessage(changedOnHost("<b>x</b>"));
    expect(message).toBe("This setting was changed on <b>x</b> just now.");
    const { container } = render(<p>{message}</p>);
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(message)).toBeTruthy();
  });
});

describe("staleWriteOf", () => {
  it("reads the detail off a stale-write HostRpcError", () => {
    expect(staleWriteOf(staleError(DASHBOARD))).toEqual(DASHBOARD);
  });

  it("is null for a HostRpcError of another code, a malformed detail and a non-HostRpcError", () => {
    expect(staleWriteOf(plainError("RPC_ERROR"))).toBeNull();
    expect(
      staleWriteOf(
        HostRpcError.fromWireEnvelope(
          {
            code: "ENVIRONMENT_WRITE_STALE",
            message: "stale",
            staleWrite: { changedBy: { kind: "nobody" } },
          },
          "req-bad",
          "config.env.set",
        ),
      ),
    ).toBeNull();
    expect(staleWriteOf(new Error("stale"))).toBeNull();
    expect(staleWriteOf(null)).toBeNull();
  });
});

describe("a stale save in the host error toast", () => {
  it("tells the person where the change came from with toast.info, not the reportable error toast", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");
    toastFromHostError(staleError(changedOnHost("dev-box")), "Couldn't save.");
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(
      "This setting was changed on dev-box just now.",
      { id: "environment-write-stale" },
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(useAppLocalNotificationsStore.getState().orderedIds).toHaveLength(0);
  });

  it("does the same on the background-mutation policy", () => {
    toastFromHostErrorWithDetail(staleError(DASHBOARD), "Couldn't save.");
    expect(toast.info).toHaveBeenCalledWith(
      "This setting was changed in the dashboard just now.",
      { id: "environment-write-stale" },
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps the error toast for an error with no stale-write detail", () => {
    toastFromHostError(plainError("FORBIDDEN"), "Couldn't save.");
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "You don't have permission to do that.",
    );
  });
});

describe("useRereadOnStaleWrite", () => {
  function setup(hostId: string | null) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hostAKey = [...queryKeys.hostScope("host-a"), "config.env.list", {}];
    const hostBKey = [...queryKeys.hostScope("host-b"), "config.env.list", {}];
    queryClient.setQueryData(hostAKey, { entries: [] });
    queryClient.setQueryData(hostBKey, { entries: [] });
    const rendered = renderHook(
      () => {
        useRereadOnStaleWrite(hostId, null);
        return useMutation({
          mutationFn: (error: Error): Promise<never> => Promise.reject(error),
        });
      },
      { wrapper },
    );
    const fail = async (error: Error): Promise<void> => {
      await act(async () => {
        rendered.result.current.mutate(error);
        await vi.waitFor(() => {
          expect(rendered.result.current.isError).toBe(true);
        });
      });
    };
    const invalidated = (key: readonly unknown[]): boolean | undefined =>
      queryClient.getQueryState(key)?.isInvalidated;
    return { fail, invalidated, hostAKey, hostBKey };
  }

  it("re-reads this host's queries when a save loses to a newer change, and no other host's", async () => {
    const { fail, invalidated, hostAKey, hostBKey } = setup("host-a");
    expect(invalidated(hostAKey)).toBe(false);
    await fail(staleError(DASHBOARD));
    expect(invalidated(hostAKey)).toBe(true);
    expect(invalidated(hostBKey)).toBe(false);
  });

  it("does nothing for a save that failed for another reason", async () => {
    const { fail, invalidated, hostAKey } = setup("host-a");
    await fail(plainError("RPC_ERROR"));
    expect(invalidated(hostAKey)).toBe(false);
  });

  it("does nothing for a plain Error", async () => {
    const { fail, invalidated, hostAKey } = setup("host-a");
    await fail(new Error("boom"));
    expect(invalidated(hostAKey)).toBe(false);
  });

  it("does nothing without a host", async () => {
    const { fail, invalidated, hostAKey, hostBKey } = setup(null);
    await fail(staleError(DASHBOARD));
    expect(invalidated(hostAKey)).toBe(false);
    expect(invalidated(hostBKey)).toBe(false);
  });
});
