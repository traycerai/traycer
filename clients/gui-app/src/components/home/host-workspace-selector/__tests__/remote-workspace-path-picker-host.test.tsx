import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  openRemoteWorkspacePathPicker,
  useRemoteWorkspacePathPickerStore,
} from "@/lib/host/remote-workspace-path-picker";
import { RemoteWorkspacePathPickerHost } from "@/components/home/host-workspace-selector/remote-workspace-path-picker-host";

type MutateCall = {
  readonly path: string;
  readonly onSuccess: (result: unknown) => void;
  readonly onError: (error: HostRpcError) => void;
};

// The real `prepareRequestPayload` (`ws-rpc-client.ts`) throws exactly this
// shape when a v1.1 client's request can't project onto a v1.0 host's older
// schema - the wire-level signal the component's version-gate keys off.
function downgradeUnsupportedError(method: string): HostRpcError {
  return new HostRpcError({
    code: "DOWNGRADE_UNSUPPORTED",
    message: `Failed to project request params onto 1.0: ${method}`,
    requestId: "req-1",
    method,
    fatalDetails: null,
  });
}

function networkError(method: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "WebSocket dial timed out after 1000ms",
    requestId: "req-1",
    method,
    fatalDetails: null,
  });
}

const mocks = vi.hoisted(() => ({
  homeDir: undefined as string | undefined,
  homeDirError: null as HostRpcError | null,
  recent: undefined as
    Array<{ path: string; lastOpenedAt: string }> | undefined,
  recentError: null as HostRpcError | null,
  mutateCalls: [] as MutateCall[],
  isPending: false,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: { params: { operation: string } }) => {
    if (args.params.operation === "getHomeDir") {
      return {
        data:
          mocks.homeDir === undefined ? undefined : { homeDir: mocks.homeDir },
        error: mocks.homeDirError,
      };
    }
    return {
      data:
        mocks.recent === undefined
          ? undefined
          : { recentWorkspaces: mocks.recent },
      error: mocks.recentError,
    };
  },
  useHostMutation: () => ({
    isPending: mocks.isPending,
    mutate: (
      path: string,
      callbacks: {
        onSuccess: (r: unknown) => void;
        onError: (e: HostRpcError) => void;
      },
    ) => {
      mocks.mutateCalls.push({ path, ...callbacks });
    },
  }),
}));

const FAKE_CLIENT = {} as HostClient<HostRpcRegistry>;

// `openRemoteWorkspacePathPicker` updates the zustand store from outside a
// React event handler, so the resulting re-render must be flushed under
// `act` before the DOM assertions below run.
function openPicker(): Promise<readonly string[]> {
  let pending: Promise<readonly string[]> = Promise.resolve([]);
  act(() => {
    pending = openRemoteWorkspacePathPicker(FAKE_CLIENT);
  });
  return pending;
}

function getPathInput(): HTMLInputElement {
  const element = screen.getByTestId("remote-workspace-path-input");
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("remote workspace path input did not render an input");
  }
  return element;
}

function getOpenButton(): HTMLButtonElement {
  const element = screen.getByRole("button", { name: /open/i });
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("remote workspace open control did not render a button");
  }
  return element;
}

afterEach(() => {
  cleanup();
  useRemoteWorkspacePathPickerStore.setState({ request: null });
  mocks.homeDir = undefined;
  mocks.homeDirError = null;
  mocks.recent = undefined;
  mocks.recentError = null;
  mocks.mutateCalls = [];
  mocks.isPending = false;
});

describe("RemoteWorkspacePathPickerHost", () => {
  it("renders nothing until a picker request is opened", () => {
    render(<RemoteWorkspacePathPickerHost />);
    expect(screen.queryByTestId("remote-workspace-path-dialog")).toBeNull();
  });

  it("shows the home-dir and recent-workspace chips once loaded, and clicking one fills the input", () => {
    mocks.homeDir = "/home/you";
    mocks.recent = [
      { path: "/home/you/projects/api", lastOpenedAt: "2026-01-01" },
    ];
    render(<RemoteWorkspacePathPickerHost />);
    void openPicker();

    const homeChip = screen.getByText("~ home");
    fireEvent.click(homeChip);
    const input = getPathInput();
    expect(input.value).toBe("/home/you");

    fireEvent.click(screen.getByText("/home/you/projects/api"));
    expect(input.value).toBe("/home/you/projects/api");
  });

  it("submitting a valid path resolves the pending promise with the resolved path", async () => {
    render(<RemoteWorkspacePathPickerHost />);
    const pending = openPicker();

    const input = getPathInput();
    fireEvent.change(input, { target: { value: "/srv/monorepo" } });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));

    expect(mocks.mutateCalls).toHaveLength(1);
    act(() => {
      mocks.mutateCalls[0].onSuccess({
        validation: { ok: true, resolvedPath: "/srv/monorepo" },
      });
    });

    expect(await pending).toEqual(["/srv/monorepo"]);
  });

  it("shows a friendly message and does not resolve when the host rejects the path", () => {
    render(<RemoteWorkspacePathPickerHost />);
    void openPicker();

    const input = getPathInput();
    fireEvent.change(input, { target: { value: "relative/path" } });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));

    act(() => {
      mocks.mutateCalls[0].onSuccess({
        validation: { ok: false, reason: "NOT_ABSOLUTE" },
      });
    });

    expect(
      screen.getByTestId("remote-workspace-path-error").textContent,
    ).toContain("Enter an absolute path");
    // The dialog stays open — a rejection is not a resolved pick.
    expect(screen.queryByTestId("remote-workspace-path-dialog")).not.toBeNull();
  });

  it("shows a friendly message and does not resolve on a genuine transport/network error", () => {
    render(<RemoteWorkspacePathPickerHost />);
    void openPicker();

    const input = getPathInput();
    fireEvent.change(input, { target: { value: "/srv/monorepo" } });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));

    act(() => {
      mocks.mutateCalls[0].onError(networkError("workspace.prepareFolders"));
    });

    expect(screen.getByTestId("remote-workspace-path-error").textContent).toBe(
      "Couldn't reach the host to open this path.",
    );
  });

  it("proactively gates the whole picker on the real wire-level DOWNGRADE_UNSUPPORTED signal from a v1.0 host — never the generic reachability message", () => {
    mocks.homeDirError = downgradeUnsupportedError("workspace.prepareFolders");
    render(<RemoteWorkspacePathPickerHost />);
    void openPicker();

    expect(screen.getByTestId("remote-workspace-path-error").textContent).toBe(
      "This host needs updating to open workspaces remotely.",
    );
    expect(getPathInput().disabled).toBe(true);
    expect(getOpenButton().disabled).toBe(true);
    // No home-dir chip either — the query that would have populated it is
    // the same one that surfaced the version mismatch.
    expect(screen.queryByText("~ home")).toBeNull();
  });

  it("routes a DOWNGRADE_UNSUPPORTED submit-time error (the gate-query/submit race) to the same 'update your host' message, not the generic one", () => {
    render(<RemoteWorkspacePathPickerHost />);
    void openPicker();

    const input = getPathInput();
    fireEvent.change(input, { target: { value: "/srv/monorepo" } });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));

    act(() => {
      mocks.mutateCalls[0].onError(
        downgradeUnsupportedError("workspace.prepareFolders"),
      );
    });

    expect(screen.getByTestId("remote-workspace-path-error").textContent).toBe(
      "This host needs updating to open workspaces remotely.",
    );
  });

  it("cancel resolves the pending promise with an empty array", async () => {
    render(<RemoteWorkspacePathPickerHost />);
    const pending = openPicker();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(await pending).toEqual([]);
  });

  it("pressing Enter in the input submits the current path", () => {
    render(<RemoteWorkspacePathPickerHost />);
    void openPicker();

    const input = getPathInput();
    fireEvent.change(input, { target: { value: "/a/b" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mocks.mutateCalls).toHaveLength(1);
    expect(mocks.mutateCalls[0].path).toBe("/a/b");
  });
});
