import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useChatCloneOnHostSwitch } from "../use-chat-clone-on-host-switch";

const cloneOnHostSwitchMock = vi.fn<(...args: unknown[]) => () => undefined>();

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    directory: {},
    hostClient: { request: vi.fn() },
  }),
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => cloneTargetState.hostId,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => cloneTargetState.client,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));

vi.mock("@/lib/commands/actions/clone-chat-on-host-switch", () => ({
  cloneChatOnHostSwitch: (...args: unknown[]) => cloneOnHostSwitchMock(...args),
}));

const cloneTargetState = {
  hostId: "host-B" as string | null,
  client: {} as object | null,
};

const ARGS = {
  epicId: "epic-1",
  tabId: "tab-1",
  chatId: "chat-1",
  sourceHostId: "host-A",
  sourceSettings: null,
  sourceTitle: "",
  sourceOwnerUserId: "user-1",
};

beforeEach(() => {
  cloneTargetState.hostId = "host-B";
  cloneTargetState.client = {};
  cloneOnHostSwitchMock.mockClear();
  cloneOnHostSwitchMock.mockReturnValue(() => undefined);
  vi.mocked(toast).mockClear();
});

afterEach(cleanup);

/**
 * S6 - the refusal at `use-chat-clone-on-host-switch.ts:73-81`: when the
 * active host the Clone button would target IS the agent's own bound host,
 * there is nowhere to clone to. Before this refusal existed, clicking Clone
 * in that state silently did nothing - which reads as a broken button, not a
 * deliberate no-op. Already closed; this is a PIN, not a fix, and the assert
 * is on the refusal TOAST's presence, not merely on "no clone happened" -
 * that weaker assertion is also true when the button is unwired entirely, so
 * it would not tell the two states apart.
 */
describe("useChatCloneOnHostSwitch - S6 same-host refusal", () => {
  it("toasts a refusal and never starts a clone when the active host equals the agent's own bound host", () => {
    cloneTargetState.hostId = "host-A"; // same as ARGS.sourceHostId
    const { result } = renderHook(() => useChatCloneOnHostSwitch(ARGS));

    act(() => {
      result.current.clone();
    });

    expect(toast).toHaveBeenCalledWith(
      "The active host is this agent's own bound host - switch to a different host before cloning.",
    );
    expect(cloneOnHostSwitchMock).not.toHaveBeenCalled();
    expect(result.current.cloning).toBe(false);
  });

  it("starts a clone when the active host differs from the agent's bound host - the refusal is scoped, not a general block", () => {
    cloneTargetState.hostId = "host-B"; // differs from ARGS.sourceHostId
    const { result } = renderHook(() => useChatCloneOnHostSwitch(ARGS));

    act(() => {
      result.current.clone();
    });

    expect(cloneOnHostSwitchMock).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalledWith(
      "The active host is this agent's own bound host - switch to a different host before cloning.",
    );
    expect(result.current.cloning).toBe(true);
  });
});
