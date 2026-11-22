import { afterEach, expect, it, vi } from "vitest";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";

const fake = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(() =>
    Promise.resolve({ kind: "ok", catalogue: { providers: [] } }),
  ),
}));
vi.mock("electron", () => ({
  ipcRenderer: { invoke: fake.invoke, on: vi.fn(), removeListener: vi.fn() },
}));
import { buildAuthBridge } from "../auth-bridge";
afterEach(() => fake.invoke.mockClear());

it("forwards the contextual catalogue request and an explicit legacy null", async () => {
  const bridge = buildAuthBridge();
  const context = {
    environmentId: null,
    os: "linux" as const,
    cpus: 2,
    memoryMb: 4096,
    diskMb: null,
    region: "us-east",
  };
  await bridge.getSandboxCatalogue("test-bearer", context);
  await bridge.getSandboxCatalogue("test-bearer", null);
  expect(fake.invoke.mock.calls).toEqual([
    [RunnerHostInvoke.getSandboxCatalogue, "test-bearer", context],
    [RunnerHostInvoke.getSandboxCatalogue, "test-bearer", null],
  ]);
});
