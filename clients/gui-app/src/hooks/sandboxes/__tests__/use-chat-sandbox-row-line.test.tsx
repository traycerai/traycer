import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import type { TaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import {
  TaskHostsViewContext,
  useChatSandboxRowLine,
} from "@/hooks/sandboxes/use-chat-sandbox-row-line";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordEndedSandboxHost,
  useEndedSandboxHostsStore,
} from "@/stores/sandboxes/ended-sandbox-hosts-store";

/**
 * The Agents panel's line for a locked chat row, over the real hook: the
 * panel mounts rows with no host runtime, so the task's hosts arrive by
 * context and a destroy this device saw by the store.
 */

const HOST = "host-sbx";
const VIEWER = "viewer-1";
// Local time, as every sandbox row states it.
const AT = new Date(2026, 9, 28, 1, 27).getTime();
const SEEN_LINE =
  "e2e-sbx was destroyed on Oct 28 at 01:27 after resting. Its files are gone; this chat stays readable.";

function sandboxRow(sandboxEnd: TaskHostRow["sandboxEnd"]): TaskHostRow {
  return {
    hostId: HOST,
    label: "e2e-sbx",
    principal: { kind: "team", id: "team-1" },
    reach: "same_principal",
    sandboxEnd,
  };
}

function lineWith(taskHosts: TaskHostsView, locked: boolean): string | null {
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <TaskHostsViewContext.Provider value={taskHosts}>
      {children}
    </TaskHostsViewContext.Provider>
  );
  return renderHook(() => useChatSandboxRowLine(HOST, locked), { wrapper })
    .result.current;
}

describe("useChatSandboxRowLine", () => {
  beforeEach(() => {
    useEndedSandboxHostsStore.setState({ byHostId: {} });
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: VIEWER, username: "V" },
    });
  });

  afterEach(() => {
    cleanup();
    useEndedSandboxHostsStore.setState({ byHostId: {} });
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("says the end from a destroy this device saw, with no task record", () => {
    act(() => {
      recordEndedSandboxHost(HOST, {
        name: "e2e-sbx",
        at: AT,
        cause: "resting",
        actor: null,
        idleMinutes: null,
      });
    });

    expect(lineWith({ kind: "none" }, true)).toBe(SEEN_LINE);
  });

  it("says the task's record once it lands, over what this device saw", () => {
    act(() => {
      recordEndedSandboxHost(HOST, {
        name: "e2e-sbx",
        at: AT,
        cause: "resting",
        actor: null,
        idleMinutes: null,
      });
    });
    const hosts: TaskHostsView = {
      kind: "hosts",
      hosts: [
        sandboxRow({
          state: "destroyed",
          destroyedAt: AT,
          cause: "verb",
          actor: "Dana",
          idleMinutes: null,
        }),
      ],
    };

    expect(lineWith(hosts, true)).toBe(
      "e2e-sbx was destroyed on Oct 28 at 01:27 by Dana. Its files are gone; this chat stays readable.",
    );
  });

  it("says nothing for a row that is not locked, even after a destroy", () => {
    act(() => {
      recordEndedSandboxHost(HOST, {
        name: "e2e-sbx",
        at: AT,
        cause: "resting",
        actor: null,
        idleMinutes: null,
      });
    });

    expect(lineWith({ kind: "none" }, false)).toBeNull();
  });
});
