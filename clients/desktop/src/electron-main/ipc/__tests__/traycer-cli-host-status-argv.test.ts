import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import type { RunnerIpcBridge } from "../runner-ipc-bridge";

// That reasoning covers only ONE of the two skew directions, and it is the direction that was never at risk.

const mocks = vi.hoisted(() => ({
  jsonCalls: [] as ReadonlyArray<readonly string[]>[],
}));

vi.mock("../../cli/traycer-cli", () => ({
  runTraycerCli: vi.fn(),
  runTraycerCliJson: vi.fn((args: readonly string[]) => {
    mocks.jsonCalls.push([args]);
    return Promise.resolve({ running: false });
  }),
}));

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
}));

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

type InvokeRegistrar = Pick<RunnerIpcBridge, "handleInvoke">;

interface CapturedHandlers {
  readonly handlers: Map<string, InvokeHandler>;
}

function makeBridge(): {
  bridge: InvokeRegistrar;
  captured: CapturedHandlers;
} {
  const handlers = new Map<string, InvokeHandler>();
  const bridge: InvokeRegistrar = {
    handleInvoke: (channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    },
  };
  return { bridge, captured: { handlers } };
}

describe("traycerHostStatus argv (CLI-001 skew guard)", () => {
  beforeEach(() => {
    mocks.jsonCalls.length = 0;
  });

  it("passes --no-bootstrap so a version-skewed older CLI cannot install the host from a status read", async () => {
    const { registerTraycerCliIpc } = await import("../traycer-cli-ipc");
    const { bridge, captured } = makeBridge();
    registerTraycerCliIpc(bridge as RunnerIpcBridge);

    const handler = captured.handlers.get(RunnerHostInvoke.traycerHostStatus);
    expect(handler, "traycerHostStatus handler must be registered").toBeTypeOf(
      "function",
    );
    await handler?.({} as IpcMainInvokeEvent);

    expect(mocks.jsonCalls).toHaveLength(1);
    const args = mocks.jsonCalls[0]?.[0] ?? [];
    expect(args).toEqual(["host", "status", "--no-bootstrap"]);
    // Stated separately from the array equality above so a future reshuffle of
    // the argv reports the ACTUAL regression - the missing guard - rather than
    // an opaque array diff.
    expect(
      args,
      "Desktop's informational host-status read must suppress bootstrap on older CLIs",
    ).toContain("--no-bootstrap");
  });
});
