import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const { useHostMethodSupport, useHostSupportsMethod } = vi.hoisted(() => ({
  useHostMethodSupport: vi.fn(() => null as boolean | null),
  useHostSupportsMethod: vi.fn(() => false),
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "epic-session-host-test",
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport,
  useHostSupportsMethod,
}));

import {
  SET_CHAT_ARCHIVED_METHOD,
  useChatArchiveSupported,
  useChatArchiveSupportState,
} from "@/hooks/epic/use-chat-archive-support";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chat archive capability routing", () => {
  it("checks affordance support against the Epic session host", () => {
    useHostSupportsMethod.mockReturnValue(true);

    const { result } = renderHook(() => useChatArchiveSupported());

    expect(result.current).toBe(true);
    expect(useHostSupportsMethod).toHaveBeenCalledWith(
      "epic-session-host-test",
      SET_CHAT_ARCHIVED_METHOD,
    );
  });

  it("checks tri-state support against the Epic session host", () => {
    useHostMethodSupport.mockReturnValue(false);

    const { result } = renderHook(() => useChatArchiveSupportState());

    expect(result.current).toBe(false);
    expect(useHostMethodSupport).toHaveBeenCalledWith(
      "epic-session-host-test",
      SET_CHAT_ARCHIVED_METHOD,
    );
  });
});
