import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { __setManagedCommandOutputStreamClientFactoryForTests } from "@/providers/managed-command-output-stream-factory-override";
import type { ManagedCommandOutputStreamClientHandle } from "@/stores/managed-commands/managed-command-output-store";

// The transport factory is only read for a real stream; the stub below stands
// in for it.
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => () => {
    throw new Error("the stub factory owns the stream");
  },
}));

import { useManagedCommandOutputSession } from "../use-managed-command-output-session";

function stubStream(close: () => void): ManagedCommandOutputStreamClientHandle {
  return {
    loadOlder: () => undefined,
    resnapshot: () => undefined,
    close,
    streamMethodSupport: null,
  };
}

afterEach(() => {
  __setManagedCommandOutputStreamClientFactoryForTests(null);
  cleanup();
});

describe("useManagedCommandOutputSession", () => {
  it("opens the command's stream while its window is mounted and closes it the moment it unmounts, keeping nothing warm", () => {
    const close = vi.fn<() => void>();
    const opened = vi.fn<(epicId: string, commandId: string) => void>();
    __setManagedCommandOutputStreamClientFactoryForTests(
      (epicId, commandId) => {
        opened(epicId, commandId);
        return stubStream(close);
      },
    );

    const view = renderHook(() =>
      useManagedCommandOutputSession({
        epicId: "epic-1",
        commandId: "command-1",
        hostId: "sbx-host",
      }),
    );

    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith("epic-1", "command-1");
    expect(view.result.current.session).not.toBeNull();
    expect(close).not.toHaveBeenCalled();

    view.unmount();

    // No timer advanced: there is no linger to wait out.
    expect(close).toHaveBeenCalledTimes(1);
  });
});
