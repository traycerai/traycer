import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import type { RunnerIpcBridge } from "../runner-ipc-bridge";

// Pins the argv Desktop uses for its informational `host status` read.
//
// This exists because the flag was removed once, during the change that made
// the CLI's `host status` observational (audit finding CLI-001), on the
// reasoning that a CLI which no longer bootstraps has nothing left to
// suppress. That reasoning covers only ONE of the two skew directions, and it
// is the direction that was never at risk.
//
// `runTraycerCliJson` resolves the binary through `discoverCli()` - manifest,
// then PATH, then bundled - which is deliberately NOT version-matched with
// this app (`runBundledTraycerCliJson` is the version-matched one). So a
// Desktop build can drive a CLI *older* than itself, and in every such CLI
// `host status` still calls `maybeAutoBootstrap`. Without the flag, the
// renderer's boot card - a read, on a machine that is usually already
// unhealthy - would download the host, register its OS service and start it.
//
// A newer CLI parses the flag as a hidden deprecated no-op, so passing it is
// safe in both directions and omitting it is safe in only one. That asymmetry
// is the whole content of this test.

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

// The only member of the bridge `registerTraycerCliIpc` actually touches.
// Named explicitly rather than reached via `as unknown as RunnerIpcBridge`:
// the repo forbids chained assertions and `as unknown` precisely because they
// hide exactly this question - what does the collaborator really require? -
// and `RunnerIpcBridge` is assignable to this, so the single downcast below
// is a narrowing the compiler can still check.
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
