import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatCloneOnHostSwitch } from "@/components/epic-canvas/renderers/use-chat-clone-on-host-switch";

/**
 * F5: the dead-tile Clone must target the host resolved when the button was
 * pressed, and must bind its create mutation to that host BEFORE the async
 * settings resolution the clone runs.
 *
 * `cloneChatOnHostSwitch` awaits `resolveSettingsForClone` before it creates,
 * so there is a real window in which the app-wide selection can move. Reading
 * the target inside the click handler (and creating through the app-wide
 * mutation) makes that window load-bearing; resolving at render closes it.
 */

/** Annotated, not asserted, so a test can present `null`. */
function hostIdHolder(): { current: string | null } {
  return { current: "host-target" };
}

const mocks = vi.hoisted(() => ({
  effectiveHostId: hostIdHolder(),
  clientForHostId: vi.fn((hostId: string | null) =>
    hostId === null ? null : { getActiveHostId: () => hostId },
  ),
  /** The client `useEpicCreateChatForHostClient` was bound to, per render. */
  boundCreateClients: [] as (string | null)[],
  cloneCalls: [] as { readonly targetHostId: string }[],
  toasts: [] as string[],
}));

vi.mock("sonner", () => ({
  toast: Object.assign((message: string) => mocks.toasts.push(message), {
    error: (message: string) => mocks.toasts.push(message),
    info: (message: string) => mocks.toasts.push(message),
  }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    directory: { findById: () => null, getSelected: () => null },
    hostClient: { getActiveHostId: () => "host-source" },
  }),
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mocks.effectiveHostId.current,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    mocks.clientForHostId(hostId),
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: (
    client: {
      readonly getActiveHostId: () => string;
    } | null,
  ) => {
    mocks.boundCreateClients.push(client?.getActiveHostId() ?? null);
    return { mutate: vi.fn() };
  },
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));

vi.mock("@/lib/commands/actions/clone-chat-on-host-switch", () => ({
  cloneChatOnHostSwitch: (args: { readonly targetHostId: string }) => {
    mocks.cloneCalls.push({ targetHostId: args.targetHostId });
    return () => undefined;
  },
}));

const ARGS = {
  epicId: "epic-1",
  tabId: "tab-1",
  chatId: "chat-1",
  sourceHostId: "host-source",
  sourceSettings: null,
  sourceTitle: "",
  sourceOwnerUserId: null,
};

beforeEach(() => {
  mocks.effectiveHostId.current = "host-target";
  mocks.boundCreateClients = [];
  mocks.cloneCalls = [];
  mocks.toasts = [];
  // `mockClear` keeps the previous implementation, so restore it explicitly -
  // otherwise the unaddressable case leaks into every test after it.
  mocks.clientForHostId.mockReset();
  mocks.clientForHostId.mockImplementation((hostId: string | null) =>
    hostId === null ? null : { getActiveHostId: () => hostId },
  );
});

describe("dead-tile clone freezes its target host", () => {
  it("binds the create mutation to the render-resolved target, not the app-wide one", () => {
    renderHook(() => useChatCloneOnHostSwitch(ARGS));

    // The mutation is already bound to the target BEFORE any click, which is
    // what makes a mid-resolution move harmless.
    expect(mocks.boundCreateClients).toContain("host-target");
    expect(mocks.clientForHostId).toHaveBeenCalledWith("host-target");
  });

  it("clones to the host that was resolved at click time", () => {
    const { result } = renderHook(() => useChatCloneOnHostSwitch(ARGS));

    act(() => {
      result.current.clone();
    });

    expect(mocks.cloneCalls).toEqual([{ targetHostId: "host-target" }]);
    expect(result.current.cloning).toBe(true);
  });

  it("refuses when the target cannot be addressed rather than starting a doomed clone", () => {
    mocks.clientForHostId.mockImplementation(() => null);
    const { result } = renderHook(() => useChatCloneOnHostSwitch(ARGS));

    act(() => {
      result.current.clone();
    });

    expect(mocks.cloneCalls).toEqual([]);
    expect(mocks.toasts.join(" ")).toContain("can't be reached");
    // The projection-wait subscription must never have been armed.
    expect(result.current.cloning).toBe(false);
  });

  it("refuses when the target is the agent's own bound host", () => {
    mocks.effectiveHostId.current = "host-source";
    const { result } = renderHook(() => useChatCloneOnHostSwitch(ARGS));

    act(() => {
      result.current.clone();
    });

    expect(mocks.cloneCalls).toEqual([]);
    expect(mocks.toasts.join(" ")).toContain("own bound host");
  });

  it("refuses when no host is resolved at all", () => {
    mocks.effectiveHostId.current = null;
    const { result } = renderHook(() => useChatCloneOnHostSwitch(ARGS));

    act(() => {
      result.current.clone();
    });

    expect(mocks.cloneCalls).toEqual([]);
    expect(mocks.toasts.join(" ")).toContain("Pick an active host");
  });
});
