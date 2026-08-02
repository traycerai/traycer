import { afterEach, describe, expect, it } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
  openRemoteWorkspacePathPicker,
  useRemoteWorkspacePathPickerStore,
} from "@/lib/host/remote-workspace-path-picker";

const FAKE_CLIENT = {} as HostClient<HostRpcRegistry>;

afterEach(() => {
  useRemoteWorkspacePathPickerStore.setState({ request: null });
});

describe("remote workspace path picker", () => {
  it("mirrors IRunnerHost.workspaceFolders.pickFolders(): resolves with the chosen path", async () => {
    const pending = openRemoteWorkspacePathPicker(FAKE_CLIENT);
    expect(useRemoteWorkspacePathPickerStore.getState().request).not.toBeNull();

    useRemoteWorkspacePathPickerStore.getState().settle(["/home/you/api"]);

    expect(await pending).toEqual(["/home/you/api"]);
    expect(useRemoteWorkspacePathPickerStore.getState().request).toBeNull();
  });

  it("resolves with an empty array on cancel", async () => {
    const pending = openRemoteWorkspacePathPicker(FAKE_CLIENT);
    useRemoteWorkspacePathPickerStore.getState().settle([]);
    expect(await pending).toEqual([]);
  });

  it("settle is a no-op once already settled (does not resolve twice)", async () => {
    const pending = openRemoteWorkspacePathPicker(FAKE_CLIENT);
    useRemoteWorkspacePathPickerStore.getState().settle(["/a"]);
    // A second settle after the request is already cleared must not throw or
    // resolve anything further.
    expect(() =>
      useRemoteWorkspacePathPickerStore.getState().settle(["/b"]),
    ).not.toThrow();
    expect(await pending).toEqual(["/a"]);
  });

  it("a second open before the first settles cancels the first (single-flight)", async () => {
    const first = openRemoteWorkspacePathPicker(FAKE_CLIENT);
    const second = openRemoteWorkspacePathPicker(FAKE_CLIENT);

    expect(await first).toEqual([]);

    useRemoteWorkspacePathPickerStore.getState().settle(["/only-second"]);
    expect(await second).toEqual(["/only-second"]);
  });
});
