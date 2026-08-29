import { act, render } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { ReactElement } from "react";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  useEpicDeleteArtifact,
  useEpicRenameArtifact,
  useEpicUpdateArtifactStatus,
} from "@/hooks/epic/use-epic-node-mutations";

/**
 * Pin for the trap `use-epic-node-mutations.ts` reintroduced: reading
 * `isPending` as `handle.store(selector)` (the bound-store call form) is not
 * recognizable as a hook to the React Compiler, which memoizes the call on
 * `handle` and skips it on the next render with the same handle - shifting
 * the hook order and throwing "Should have a queue". Only a suite compiled
 * through `vitest.react-compiler.config.ts` can see this; the plain config
 * does not run the compiler at all.
 */

function fakeFactory(): EpicStreamClientFactory {
  return () => ({
    applyUpdate: () => {},
    awareness: () => {},
    applyArtifactRoomUpdate: () => {},
    artifactRoomAwareness: () => {},
    retryMigration: () => {},
    close: () => {},
  });
}

function TestHarness(props: { readonly renderKey: number }): ReactElement {
  const del = useEpicDeleteArtifact();
  const status = useEpicUpdateArtifactStatus();
  const rename = useEpicRenameArtifact(true);
  const isPending = del.isPending || status.isPending || rename.isPending;
  return (
    <div data-testid="pending" data-render-key={props.renderKey}>
      {String(isPending)}
    </div>
  );
}

describe("use-epic-node-mutations under React Compiler", () => {
  let handle: OpenEpicStoreHandle;
  let consoleErrorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    window.localStorage.clear();
    handle = createOpenEpicStore({
      epicId: "epic-compiler-pin",
      streamClientFactory: fakeFactory(),
      userId: null,
      onAuthError: null,
      laneSelection: null,
    });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    handle.dispose();
  });

  it("re-renders the same handle across multiple passes with no hook-order error", () => {
    const { getByTestId, rerender } = render(
      <EpicSessionContext.Provider value={handle}>
        <TestHarness renderKey={1} />
      </EpicSessionContext.Provider>,
    );
    rerender(
      <EpicSessionContext.Provider value={handle}>
        <TestHarness renderKey={2} />
      </EpicSessionContext.Provider>,
    );
    rerender(
      <EpicSessionContext.Provider value={handle}>
        <TestHarness renderKey={3} />
      </EpicSessionContext.Provider>,
    );

    // A store-driven re-render - the same trigger a real pending write
    // command uses - is what surfaces the trap: it re-renders the SAME
    // mounted fiber (same `handle` reference) via the zustand subscription
    // itself, not via a new element from the test.
    act(() => {
      handle.store.setState({
        writeCommands: [
          {
            commandId: "cmd-1",
            intent: { kind: "delete-artifact", artifactId: "art-1" },
            state: "pending",
            delivery: "sending",
            issuedAtMs: 0,
            attempts: 1,
            expectedEntityVersion: null,
            resolution: null,
          },
        ],
      });
    });
    expect(getByTestId("pending").textContent).toBe("true");

    act(() => {
      handle.store.setState({ writeCommands: [] });
    });
    expect(getByTestId("pending").textContent).toBe("false");

    const hookOrderErrors = consoleErrorSpy.mock.calls
      .flat()
      .filter(
        (arg: unknown): arg is string =>
          typeof arg === "string" &&
          arg.includes("change in the order of Hooks"),
      );
    expect(hookOrderErrors).toEqual([]);
  });
});
