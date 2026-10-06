import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  ChatAutoArchiveGetResponse,
  ChatAutoArchiveSetRequest,
} from "@traycer/protocol/host/chat-auto-archive/contracts";

interface QueryState {
  data: ChatAutoArchiveGetResponse | undefined;
  isError: boolean;
  isPending: boolean;
}

interface Harness {
  getSupport: boolean | null;
  setSupport: boolean | null;
  query: QueryState;
  mutate: Mock<(request: ChatAutoArchiveSetRequest) => void>;
  mutationPending: boolean;
  trackSettingChanged: Mock<(section: string, setting: string) => void>;
}

const harness = vi.hoisted((): Harness => ({
  getSupport: true,
  setSupport: true,
  query: {
    data: undefined,
    isError: false,
    isPending: false,
  },
  mutate: vi.fn<(request: ChatAutoArchiveSetRequest) => void>(),
  mutationPending: false,
  trackSettingChanged: vi.fn(),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) => {
    if (method === "chatAutoArchive.get") return harness.getSupport;
    if (method === "chatAutoArchive.set") return harness.setSupport;
    return false;
  },
}));

vi.mock("@/hooks/chat-auto-archive/use-chat-auto-archive-policy-query", () => ({
  useChatAutoArchivePolicyQuery: () => harness.query,
}));

vi.mock("@/hooks/chat-auto-archive/use-chat-auto-archive-set-mutation", () => ({
  useChatAutoArchiveSetMutation: () => ({
    mutate: harness.mutate,
    isPending: harness.mutationPending,
  }),
}));

vi.mock("@/lib/analytics", () => ({
  trackSettingChanged: (section: string, setting: string): void => {
    harness.trackSettingChanged(section, setting);
  },
}));

import { ChatAutoArchiveSettingsRow } from "@/components/settings/panels/chat-auto-archive-settings-row";
import {
  CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS,
  chatAutoArchiveStatusLine,
  formatIdleSeconds,
} from "@/components/settings/panels/chat-auto-archive-copy";

const NEVER_SAVED: ChatAutoArchiveGetResponse = {
  policy: null,
  bounds: { minSeconds: 1, maxSeconds: 31_536_000 },
};

const NEVER_SAVED_WRITE: ChatAutoArchiveSetRequest = {
  enabled: false,
  includeUserCreated: false,
  idleSeconds: 3600,
};

function renderRow(): void {
  render(<ChatAutoArchiveSettingsRow />);
}

function mainSwitch(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("switch", {
    name: "Archive idle agents automatically",
  });
}

function includeSwitch(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("switch", {
    name: "Also archive chats I created",
  });
}

function idleInput(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("textbox", {
    name: "Idle seconds before archiving",
  });
}

function expectWrite(request: ChatAutoArchiveSetRequest): void {
  expect(harness.mutate).toHaveBeenCalledTimes(1);
  expect(harness.mutate).toHaveBeenCalledWith(request);
  expect(harness.trackSettingChanged).toHaveBeenCalledTimes(1);
  expect(harness.trackSettingChanged).toHaveBeenCalledWith(
    "general",
    "chatAutoArchive",
  );
}

describe("<ChatAutoArchiveSettingsRow />", () => {
  beforeEach(() => {
    harness.getSupport = true;
    harness.setSupport = true;
    harness.query = {
      data: undefined,
      isError: false,
      isPending: false,
    };
    harness.mutate.mockReset();
    harness.mutationPending = false;
    harness.trackSettingChanged.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    { get: false, set: true },
    { get: true, set: false },
    { get: null, set: true },
    { get: true, set: null },
    { get: false, set: false },
    { get: null, set: null },
  ] as const)(
    "is absent when get support is $get and set support is $set",
    ({ get, set }) => {
      harness.getSupport = get;
      harness.setSupport = set;
      renderRow();
      expect(
        screen.queryByRole("switch", {
          name: "Archive idle agents automatically",
        }),
      ).toBeNull();
      expect(
        screen.queryByText("Archive idle agents automatically"),
      ).toBeNull();
    },
  );

  it("is present when both methods are supported", () => {
    harness.query.data = NEVER_SAVED;
    renderRow();
    expect(mainSwitch()).toBeTruthy();
    expect(includeSwitch()).toBeTruthy();
    expect(idleInput()).toBeTruthy();
  });

  it("disables controls and shows no error while the query has not landed", () => {
    renderRow();
    expect(mainSwitch().disabled).toBe(true);
    expect(includeSwitch().disabled).toBe(true);
    expect(idleInput().disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS)).toBeNull();
    // No status sentence either: before the read lands the row knows no policy.
    expect(screen.queryByText("Off on all your hosts.")).toBeNull();
  });

  it("renders the never-saved default of 3600 with both switches off", () => {
    harness.query.data = NEVER_SAVED;
    renderRow();
    expect(idleInput().value).toBe("3600");
    expect(idleInput().disabled).toBe(false);
    expect(mainSwitch().disabled).toBe(false);
    expect(includeSwitch().disabled).toBe(false);
    expect(mainSwitch().getAttribute("aria-checked")).toBe("false");
    expect(includeSwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Off on all your hosts.")).toBeTruthy();
  });

  it("writes all three fields when the main switch is toggled", () => {
    harness.query.data = NEVER_SAVED;
    renderRow();
    fireEvent.click(mainSwitch());
    expectWrite({ ...NEVER_SAVED_WRITE, enabled: true });
  });

  it("writes all three fields when the include-user-created label is toggled", () => {
    harness.query.data = NEVER_SAVED;
    renderRow();
    fireEvent.click(screen.getByText("Also archive chats I created"));
    expectWrite({ ...NEVER_SAVED_WRITE, includeUserCreated: true });
  });

  it("commits a changed idle-seconds value on blur", () => {
    harness.query.data = NEVER_SAVED;
    renderRow();
    fireEvent.change(idleInput(), { target: { value: "7200" } });
    fireEvent.blur(idleInput());
    expectWrite({ ...NEVER_SAVED_WRITE, idleSeconds: 7200 });
  });

  it("commits a changed idle-seconds value on Enter", () => {
    harness.query.data = NEVER_SAVED;
    renderRow();
    const input = idleInput();
    input.focus();
    fireEvent.change(input, { target: { value: "7200" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expectWrite({ ...NEVER_SAVED_WRITE, idleSeconds: 7200 });
  });

  it("refuses an out-of-range or non-integer idle-seconds value without mutating", () => {
    harness.query.data = NEVER_SAVED;
    renderRow();
    for (const value of ["0", "31536001", "1.5"]) {
      fireEvent.change(idleInput(), { target: { value } });
      fireEvent.blur(idleInput());
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(harness.mutate).not.toHaveBeenCalled();
      expect(harness.trackSettingChanged).not.toHaveBeenCalled();
    }
  });

  it("commits nothing when the idle-seconds value is unchanged", () => {
    harness.query.data = NEVER_SAVED;
    renderRow();
    fireEvent.change(idleInput(), { target: { value: "3600" } });
    fireEvent.blur(idleInput());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(harness.mutate).not.toHaveBeenCalled();
    expect(harness.trackSettingChanged).not.toHaveBeenCalled();
  });

  it("shows the read-error status when the query failed", () => {
    harness.query.isError = true;
    renderRow();
    expect(screen.getByText(CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS)).toBeTruthy();
  });

  it("disables controls and shows the spinner while a write is pending", () => {
    harness.query.data = NEVER_SAVED;
    harness.mutationPending = true;
    renderRow();
    expect(mainSwitch().disabled).toBe(true);
    expect(includeSwitch().disabled).toBe(true);
    expect(idleInput().disabled).toBe(true);
    expect(screen.getByTestId("chat-auto-archive-spinner")).toBeTruthy();
  });
});

describe("chat auto-archive copy", () => {
  it("formats idle seconds in whole units", () => {
    expect(formatIdleSeconds(90)).toBe("90 seconds");
    expect(formatIdleSeconds(3600)).toBe("1 hour");
    expect(formatIdleSeconds(9000)).toBe("2 hours 30 minutes");
  });

  it("renders the enabled status line", () => {
    expect(
      chatAutoArchiveStatusLine({
        enabled: true,
        includeUserCreated: false,
        idleSeconds: 3600,
      }),
    ).toBe(
      "After 1 hour of inactivity, on all your hosts. Applied when a host next looks at the chat's task.",
    );
  });
});
