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
  ChatAutoArchiveBounds,
  ChatAutoArchiveGetResponse,
  ChatAutoArchiveSetRequest,
} from "@traycer/protocol/host/chat-auto-archive/contracts";

interface QueryState {
  data: ChatAutoArchiveGetResponse | undefined;
  isError: boolean;
  isPending: boolean;
}

interface MutateCallOptions {
  onError?: (error: Error) => void;
}

type MutateFn = (
  request: ChatAutoArchiveSetRequest,
  options: MutateCallOptions | undefined,
) => void;

interface Harness {
  viewerUserId: string;
  getSupport: boolean | null;
  setSupport: boolean | null;
  query: QueryState;
  mutate: Mock<MutateFn>;
  mutationPending: boolean;
  trackSettingChanged: Mock<(section: string, setting: string) => void>;
}

const harness = vi.hoisted((): Harness => ({
  viewerUserId: "user-a",
  getSupport: true,
  setSupport: true,
  query: {
    data: undefined,
    isError: false,
    isPending: false,
  },
  mutate: vi.fn<MutateFn>(),
  mutationPending: false,
  trackSettingChanged: vi.fn(),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => harness.viewerUserId,
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
  CHAT_AUTO_ARCHIVE_ON_FOOTNOTE,
  CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS,
  formatIdleSeconds,
  idlePresetsWithin,
  idleUnitFor,
  idleUnitsFor,
} from "@/components/settings/panels/chat-auto-archive-copy";

const FULL_BOUNDS: ChatAutoArchiveBounds = {
  minSeconds: 1,
  maxSeconds: 31_536_000,
};

/** Too narrow for any named preset: 1 hour is the smallest one. */
const NARROW_BOUNDS: ChatAutoArchiveBounds = {
  minSeconds: 7200,
  maxSeconds: 9000,
};

function savedPolicy(
  enabled: boolean,
  includeUserCreated: boolean,
  idleSeconds: number,
  bounds: ChatAutoArchiveBounds,
): ChatAutoArchiveGetResponse {
  return {
    policy: { enabled, includeUserCreated, idleSeconds, updatedAt: 1 },
    bounds,
  };
}

const ROW_DESCRIPTION =
  "Tidy up chats agents started once they go quiet. Applies on all your hosts.";

const NEVER_SAVED: ChatAutoArchiveGetResponse = {
  policy: null,
  bounds: FULL_BOUNDS,
};

/** On, agent-created chats only, 1 hour: a named preset. */
const SAVED_ENABLED_PRESET = savedPolicy(true, false, 3600, FULL_BOUNDS);

/** On, 90 minutes: not a preset, so the custom field is open from the start. */
const SAVED_ENABLED_CUSTOM = savedPolicy(true, false, 5400, FULL_BOUNDS);

const ENABLED_PRESET_WRITE: ChatAutoArchiveSetRequest = {
  enabled: true,
  includeUserCreated: false,
  idleSeconds: 3600,
};

const ENABLED_CUSTOM_WRITE: ChatAutoArchiveSetRequest = {
  enabled: true,
  includeUserCreated: false,
  idleSeconds: 5400,
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
    name: "Include chats I started",
  });
}

function archiveAfterSelect(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("combobox", {
    name: "Archive after",
  });
}

function customInput(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("textbox", {
    name: "Custom idle time",
  });
}

function unitSelect(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("combobox", {
    name: "Idle time unit",
  });
}

function expectOptionsAbsent(): void {
  expect(screen.queryByRole("combobox", { name: "Archive after" })).toBeNull();
  expect(
    screen.queryByRole("switch", { name: "Include chats I started" }),
  ).toBeNull();
  expect(
    screen.queryByRole("textbox", { name: "Custom idle time" }),
  ).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Idle time unit" })).toBeNull();
  expect(screen.queryByText(CHAT_AUTO_ARCHIVE_ON_FOOTNOTE)).toBeNull();
}

/** Opens a Radix select the way jsdom can (the keyboard), then picks an option. */
function pickOption(trigger: HTMLElement, optionName: string): void {
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

/** Opens a Radix select and returns the labels it offers, in order. */
function openOptionLabels(trigger: HTMLElement): string[] {
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.getAllByRole("option").map((option) => option.textContent);
}

function typeCustom(value: string): void {
  fireEvent.change(customInput(), { target: { value } });
}

function expectWrite(request: ChatAutoArchiveSetRequest): void {
  expect(harness.mutate).toHaveBeenCalledTimes(1);
  expect(harness.mutate.mock.calls[0]?.[0]).toEqual(request);
  expect(harness.trackSettingChanged).toHaveBeenCalledTimes(1);
  expect(harness.trackSettingChanged).toHaveBeenCalledWith(
    "general",
    "chatAutoArchive",
  );
}

function expectNoWrite(): void {
  expect(harness.mutate).not.toHaveBeenCalled();
  expect(harness.trackSettingChanged).not.toHaveBeenCalled();
}

describe("<ChatAutoArchiveSettingsRow />", () => {
  beforeEach(() => {
    harness.viewerUserId = "user-a";
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

  describe("availability and loading", () => {
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

    it("disables the main switch and shows no options or error while the query has not landed", () => {
      renderRow();
      expect(mainSwitch().disabled).toBe(true);
      expect(mainSwitch().getAttribute("aria-checked")).toBe("false");
      expectOptionsAbsent();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.queryByText(CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS),
      ).toBeNull();
      expect(screen.getByText(ROW_DESCRIPTION)).toBeTruthy();
    });

    it("shows the description and the read-error status, and no options, when the query failed", () => {
      harness.query.isError = true;
      renderRow();
      expect(screen.getByText(ROW_DESCRIPTION)).toBeTruthy();
      expect(
        screen.getByText(CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS),
      ).toBeTruthy();
      expect(mainSwitch().disabled).toBe(true);
      expectOptionsAbsent();
    });
  });

  describe("with the setting off", () => {
    it("shows an enabled, unchecked main switch and no options for a never-saved policy", () => {
      harness.query.data = NEVER_SAVED;
      renderRow();
      expect(mainSwitch().disabled).toBe(false);
      expect(mainSwitch().getAttribute("aria-checked")).toBe("false");
      expectOptionsAbsent();
    });

    it("writes all three fields when a never-saved policy is switched on", () => {
      harness.query.data = NEVER_SAVED;
      renderRow();
      fireEvent.click(mainSwitch());
      expectWrite({
        enabled: true,
        includeUserCreated: false,
        idleSeconds: 3600,
      });
    });

    it("keeps the saved choices when a saved-off policy is switched on", () => {
      harness.query.data = savedPolicy(false, true, 5400, FULL_BOUNDS);
      renderRow();
      expectOptionsAbsent();
      fireEvent.click(mainSwitch());
      expectWrite({
        enabled: true,
        includeUserCreated: true,
        idleSeconds: 5400,
      });
    });

    it("clamps the never-saved threshold into the host's bounds when switched on", () => {
      harness.query.data = { policy: null, bounds: NARROW_BOUNDS };
      renderRow();
      fireEvent.click(mainSwitch());
      expectWrite({
        enabled: true,
        includeUserCreated: false,
        idleSeconds: 7200,
      });
    });
  });

  describe("with the setting on", () => {
    it("shows the options, the footnote and the saved preset", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      expect(mainSwitch().getAttribute("aria-checked")).toBe("true");
      expect(archiveAfterSelect().textContent).toBe("1 hour");
      expect(includeSwitch().getAttribute("aria-checked")).toBe("false");
      expect(screen.getByText(CHAT_AUTO_ARCHIVE_ON_FOOTNOTE)).toBeTruthy();
      expect(
        screen.getByText("Terminal agent chats count as yours"),
      ).toBeTruthy();
      // A named preset needs no custom field.
      expect(
        screen.queryByRole("textbox", { name: "Custom idle time" }),
      ).toBeNull();
    });

    it("describes the include switch with its hint", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      const hint = screen.getByText("Terminal agent chats count as yours");
      expect(includeSwitch().getAttribute("aria-describedby")).toBe(hint.id);
    });

    it("offers the six presets by name, then Custom", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      expect(openOptionLabels(archiveAfterSelect())).toEqual([
        "1 hour",
        "6 hours",
        "1 day",
        "3 days",
        "7 days",
        "30 days",
        "Custom…",
      ]);
    });

    it("writes the picked preset, with the other fields unchanged", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "1 day");
      expectWrite({ ...ENABLED_PRESET_WRITE, idleSeconds: 86_400 });
    });

    it("writes nothing when the saved preset is picked again", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "1 hour");
      expectNoWrite();
    });

    it("writes includeUserCreated with the other fields unchanged when the include switch is toggled", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      fireEvent.click(includeSwitch());
      expectWrite({ ...ENABLED_PRESET_WRITE, includeUserCreated: true });
    });

    it("toggles the include switch from its label", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      fireEvent.click(screen.getByText("Include chats I started"));
      expectWrite({ ...ENABLED_PRESET_WRITE, includeUserCreated: true });
    });

    it("keeps the saved choices when the main switch is turned off", () => {
      harness.query.data = savedPolicy(true, true, 5400, FULL_BOUNDS);
      renderRow();
      fireEvent.click(mainSwitch());
      expectWrite({
        enabled: false,
        includeUserCreated: true,
        idleSeconds: 5400,
      });
    });
  });

  describe("custom threshold", () => {
    it("writes nothing when Custom is picked, and opens the field on the saved value", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      expectNoWrite();
      expect(archiveAfterSelect().textContent).toBe("Custom…");
      expect(customInput().value).toBe("1");
      expect(unitSelect().textContent).toBe("hours");
    });

    it("commits the typed value on blur", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      typeCustom("2");
      expectNoWrite();
      fireEvent.blur(customInput());
      expectWrite({ ...ENABLED_PRESET_WRITE, idleSeconds: 7200 });
    });

    it("commits the typed value on Enter", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      const input = customInput();
      input.focus();
      typeCustom("2");
      fireEvent.keyDown(input, { key: "Enter" });
      expectWrite({ ...ENABLED_PRESET_WRITE, idleSeconds: 7200 });
    });

    it("does not commit on an Enter that confirms an IME composition", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      const input = customInput();
      input.focus();
      typeCustom("2");
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
      expect(document.activeElement).toBe(input);
      expectNoWrite();
    });

    it("commits the same amount in the new unit when the unit changes", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      pickOption(unitSelect(), "days");
      expectWrite({ ...ENABLED_PRESET_WRITE, idleSeconds: 86_400 });
    });

    it("does not commit when focus moves from the number to the unit picker, and the unit pick then writes once", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      typeCustom("2");
      fireEvent.blur(customInput(), { relatedTarget: unitSelect() });
      expectNoWrite();

      pickOption(unitSelect(), "days");
      expectWrite({ ...ENABLED_PRESET_WRITE, idleSeconds: 2 * 86_400 });
    });

    it("does not commit when focus moves from the number into the open unit list", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      typeCustom("2");
      // Taken before the list opens: Radix hides everything else from role
      // queries while it is open.
      const input = customInput();
      fireEvent.keyDown(unitSelect(), { key: "Enter" });
      fireEvent.blur(input, {
        relatedTarget: screen.getByRole("option", { name: "days" }),
      });
      expectNoWrite();
    });

    it("does not commit when focus moves from the number into the open preset list, and the preset pick then writes once", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      typeCustom("5");
      // Taken before the list opens: Radix hides everything else from role
      // queries while it is open.
      const input = customInput();
      fireEvent.keyDown(archiveAfterSelect(), { key: "Enter" });
      fireEvent.blur(input, {
        relatedTarget: screen.getByRole("option", { name: "Custom…" }),
      });
      expectNoWrite();
      fireEvent.click(screen.getByRole("option", { name: "1 day" }));
      expectWrite({ ...ENABLED_PRESET_WRITE, idleSeconds: 86_400 });
    });

    it("writes nothing more when focus leaves the field while a unit pick's save is pending", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      const { rerender } = render(<ChatAutoArchiveSettingsRow />);
      pickOption(archiveAfterSelect(), "Custom…");
      pickOption(unitSelect(), "days");
      expectWrite({ ...ENABLED_PRESET_WRITE, idleSeconds: 86_400 });

      // The save is now in flight; the saved prop has not moved, so only the
      // pending guard stands between this blur and a second identical write.
      harness.mutationPending = true;
      rerender(<ChatAutoArchiveSettingsRow />);
      fireEvent.blur(unitSelect(), { relatedTarget: null });
      expect(harness.mutate).toHaveBeenCalledTimes(1);
      expect(harness.trackSettingChanged).toHaveBeenCalledTimes(1);
    });

    it.each([
      { label: "nothing", target: (): HTMLElement | null => null },
      {
        label: "an element outside the field",
        target: (): HTMLElement | null => document.body,
      },
    ])("commits once when focus leaves the number to $label", ({ target }) => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      typeCustom("2");
      fireEvent.blur(customInput(), { relatedTarget: target() });
      expectWrite({ ...ENABLED_PRESET_WRITE, idleSeconds: 7200 });
    });

    it("does not save a typed custom value when a preset is picked instead", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      typeCustom("5");
      // Focus moving from the number to the preset picker stays inside the
      // control, so the typed 5 is not committed on its own.
      fireEvent.blur(customInput(), { relatedTarget: archiveAfterSelect() });
      expectNoWrite();

      // The preset replaces the draft: one write, the preset's, never the 5.
      pickOption(archiveAfterSelect(), "1 day");
      expectWrite({ ...ENABLED_PRESET_WRITE, idleSeconds: 86_400 });
    });

    it("drops the custom draft when a preset is picked", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      typeCustom("5");
      expect(customInput().value).toBe("5");

      // The saved preset again: it writes nothing, but it still replaces the
      // draft and closes the field.
      pickOption(archiveAfterSelect(), "1 hour");
      expectNoWrite();

      pickOption(archiveAfterSelect(), "Custom…");
      expect(customInput().value).toBe("1");
      expect(unitSelect().textContent).toBe("hours");
      expectNoWrite();
    });

    it("still saves a typed custom value when focus leaves via the preset picker", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "Custom…");
      typeCustom("5");
      const presetSelect = archiveAfterSelect();
      fireEvent.blur(customInput(), { relatedTarget: presetSelect });
      expectNoWrite();

      // Focus then leaves the control from the preset picker itself.
      fireEvent.blur(presetSelect, { relatedTarget: null });
      expectWrite({ ...ENABLED_PRESET_WRITE, idleSeconds: 5 * 3600 });
    });

    it("commits nothing when the typed value equals the saved one", () => {
      harness.query.data = SAVED_ENABLED_CUSTOM;
      renderRow();
      typeCustom("90");
      fireEvent.blur(customInput());
      expect(screen.queryByRole("alert")).toBeNull();
      expectNoWrite();
    });

    it("shows a saved non-preset value as Custom, in the largest exact unit", () => {
      harness.query.data = SAVED_ENABLED_CUSTOM;
      renderRow();
      expect(archiveAfterSelect().textContent).toBe("Custom…");
      expect(customInput().value).toBe("90");
      expect(unitSelect().textContent).toBe("minutes");
    });

    it("offers seconds only when the saved value needs them", () => {
      harness.query.data = SAVED_ENABLED_CUSTOM;
      renderRow();
      expect(openOptionLabels(unitSelect())).toEqual([
        "minutes",
        "hours",
        "days",
      ]);
      cleanup();

      harness.query.data = savedPolicy(true, false, 90, FULL_BOUNDS);
      renderRow();
      expect(customInput().value).toBe("90");
      expect(unitSelect().textContent).toBe("seconds");
      expect(openOptionLabels(unitSelect())).toEqual([
        "seconds",
        "minutes",
        "hours",
        "days",
      ]);
    });

    it("keeps seconds listed after the draft unit moves off it, so the saved value stays reachable", () => {
      // The mutate mock is a no-op, so the saved value stays 90 seconds.
      harness.query.data = savedPolicy(true, false, 90, FULL_BOUNDS);
      renderRow();
      expect(customInput().value).toBe("90");
      expect(unitSelect().textContent).toBe("seconds");

      pickOption(unitSelect(), "minutes");
      expectWrite({ ...ENABLED_PRESET_WRITE, idleSeconds: 90 * 60 });
      expect(unitSelect().textContent).toBe("minutes");

      expect(openOptionLabels(unitSelect())).toContain("seconds");
    });

    it.each([
      {
        label: "zero",
        value: "0",
        message: "Choose between 1 second and 365 days.",
      },
      {
        label: "past the host's maximum",
        value: "999999999",
        message: "Choose between 1 second and 365 days.",
      },
      { label: "a fraction", value: "1.5", message: "Enter a whole number." },
      { label: "text", value: "abc", message: "Enter a whole number." },
      { label: "empty", value: "", message: "Enter a number." },
    ])(
      "refuses $label on blur with an alert and writes nothing",
      ({ value, message }) => {
        harness.query.data = SAVED_ENABLED_CUSTOM;
        renderRow();
        typeCustom(value);
        fireEvent.blur(customInput());
        expect(screen.getByRole("alert").textContent).toBe(message);
        expect(customInput().getAttribute("aria-invalid")).toBe("true");
        expectNoWrite();
      },
    );

    it("clears the alert when the field is edited again", () => {
      harness.query.data = SAVED_ENABLED_CUSTOM;
      renderRow();
      typeCustom("0");
      fireEvent.blur(customInput());
      expect(screen.getByRole("alert")).toBeTruthy();
      typeCustom("45");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("restores the saved value in the field after a rejected save", () => {
      harness.query.data = SAVED_ENABLED_CUSTOM;
      harness.mutate.mockImplementation(
        (
          _request: ChatAutoArchiveSetRequest,
          options: MutateCallOptions | undefined,
        ) => {
          options?.onError?.(new Error("rejected"));
        },
      );
      renderRow();
      typeCustom("45");
      fireEvent.blur(customInput());

      expectWrite({ ...ENABLED_CUSTOM_WRITE, idleSeconds: 45 * 60 });
      expect(customInput().value).toBe("90");
      expect(unitSelect().textContent).toBe("minutes");
      expect(screen.queryByRole("alert")).toBeNull();

      // The switches write the SAVED threshold, not the refused draft.
      harness.mutate.mockReset();
      fireEvent.click(includeSwitch());
      expect(harness.mutate.mock.calls[0]?.[0]).toEqual({
        ...ENABLED_CUSTOM_WRITE,
        includeUserCreated: true,
      });
      expect(customInput().value).toBe("90");
    });

    it("restores the saved unit after a rejected unit change", () => {
      harness.query.data = SAVED_ENABLED_CUSTOM;
      harness.mutate.mockImplementation(
        (
          _request: ChatAutoArchiveSetRequest,
          options: MutateCallOptions | undefined,
        ) => {
          options?.onError?.(new Error("rejected"));
        },
      );
      renderRow();
      pickOption(unitSelect(), "hours");

      expectWrite({ ...ENABLED_CUSTOM_WRITE, idleSeconds: 90 * 3600 });
      expect(customInput().value).toBe("90");
      expect(unitSelect().textContent).toBe("minutes");
    });

    it("sends a preset pick with no rejection handler, as there is no draft to restore", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      pickOption(archiveAfterSelect(), "1 day");
      expect(harness.mutate.mock.calls[0]?.[1]).toBeUndefined();
    });
  });

  describe("the host's bounds", () => {
    it("offers no preset outside narrow bounds, only Custom", () => {
      harness.query.data = savedPolicy(true, false, 7200, NARROW_BOUNDS);
      renderRow();
      // 2 hours is no named preset, so the field is open on the saved value.
      expect(archiveAfterSelect().textContent).toBe("Custom…");
      expect(customInput().value).toBe("2");
      expect(unitSelect().textContent).toBe("hours");
      expect(openOptionLabels(archiveAfterSelect())).toEqual(["Custom…"]);
    });

    it("offers only the presets inside the bounds", () => {
      harness.query.data = savedPolicy(true, false, 21_600, {
        minSeconds: 3600,
        maxSeconds: 86_400,
      });
      renderRow();
      expect(archiveAfterSelect().textContent).toBe("6 hours");
      expect(openOptionLabels(archiveAfterSelect())).toEqual([
        "1 hour",
        "6 hours",
        "1 day",
        "Custom…",
      ]);
    });

    it("validates a custom value against the host's bounds", () => {
      harness.query.data = savedPolicy(true, false, 7200, NARROW_BOUNDS);
      renderRow();
      typeCustom("3");
      fireEvent.blur(customInput());
      expect(screen.getByRole("alert").textContent).toBe(
        "Choose between 2 hours and 2 hours 30 minutes.",
      );
      expectNoWrite();
    });
  });

  describe("while a write is pending", () => {
    it("disables the main switch and shows the spinner", () => {
      harness.query.data = NEVER_SAVED;
      harness.mutationPending = true;
      renderRow();
      expect(mainSwitch().disabled).toBe(true);
      expect(screen.getByTestId("chat-auto-archive-spinner")).toBeTruthy();
    });

    it("disables every option too", () => {
      harness.query.data = SAVED_ENABLED_CUSTOM;
      harness.mutationPending = true;
      renderRow();
      expect(mainSwitch().disabled).toBe(true);
      expect(archiveAfterSelect().disabled).toBe(true);
      expect(customInput().disabled).toBe(true);
      expect(unitSelect().disabled).toBe(true);
      expect(includeSwitch().disabled).toBe(true);
      expect(screen.getByTestId("chat-auto-archive-spinner")).toBeTruthy();
    });

    it("shows no spinner when nothing is pending", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      renderRow();
      expect(screen.queryByTestId("chat-auto-archive-spinner")).toBeNull();
    });
  });

  describe("when the viewer changes", () => {
    it("discards an outgoing custom draft", () => {
      harness.query.data = SAVED_ENABLED_CUSTOM;
      const { rerender } = render(<ChatAutoArchiveSettingsRow />);
      typeCustom("45");
      expect(customInput().value).toBe("45");

      // The incoming viewer's saved value is the SAME, so only the viewer key
      // can drop the draft.
      harness.viewerUserId = "user-b";
      harness.query.data = savedPolicy(true, false, 5400, FULL_BOUNDS);
      rerender(<ChatAutoArchiveSettingsRow />);

      expect(customInput().value).toBe("90");
      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.blur(customInput());
      expectNoWrite();
    });

    it("discards a validation error", () => {
      harness.query.data = SAVED_ENABLED_CUSTOM;
      const { rerender } = render(<ChatAutoArchiveSettingsRow />);
      typeCustom("0");
      fireEvent.blur(customInput());
      expect(screen.getByRole("alert")).toBeTruthy();

      harness.viewerUserId = "user-b";
      harness.query.data = savedPolicy(true, false, 5400, FULL_BOUNDS);
      rerender(<ChatAutoArchiveSettingsRow />);

      expect(screen.queryByRole("alert")).toBeNull();
      expect(customInput().value).toBe("90");
    });

    it("closes a custom field the outgoing viewer opened by hand", () => {
      harness.query.data = SAVED_ENABLED_PRESET;
      const { rerender } = render(<ChatAutoArchiveSettingsRow />);
      pickOption(archiveAfterSelect(), "Custom…");
      expect(customInput().value).toBe("1");

      harness.viewerUserId = "user-b";
      harness.query.data = savedPolicy(true, false, 3600, FULL_BOUNDS);
      rerender(<ChatAutoArchiveSettingsRow />);

      expect(archiveAfterSelect().textContent).toBe("1 hour");
      expect(
        screen.queryByRole("textbox", { name: "Custom idle time" }),
      ).toBeNull();
    });
  });
});

describe("chat auto-archive copy", () => {
  it("formats idle seconds in whole units", () => {
    expect(formatIdleSeconds(90)).toBe("90 seconds");
    expect(formatIdleSeconds(3600)).toBe("1 hour");
    expect(formatIdleSeconds(9000)).toBe("2 hours 30 minutes");
  });

  it("shows a threshold in the largest unit that states it exactly", () => {
    expect(idleUnitFor(86_400)).toBe("days");
    expect(idleUnitFor(3600)).toBe("hours");
    expect(idleUnitFor(5400)).toBe("minutes");
    expect(idleUnitFor(90)).toBe("seconds");
    expect(idleUnitsFor("hours")).toEqual(["minutes", "hours", "days"]);
    expect(idleUnitsFor("seconds")).toEqual([
      "seconds",
      "minutes",
      "hours",
      "days",
    ]);
  });

  it("offers every preset inside wide bounds", () => {
    expect(idlePresetsWithin(FULL_BOUNDS)).toEqual([
      3600, 21_600, 86_400, 259_200, 604_800, 2_592_000,
    ]);
  });

  it("filters the presets by the host's bounds, edges included", () => {
    expect(
      idlePresetsWithin({ minSeconds: 21_600, maxSeconds: 604_800 }),
    ).toEqual([21_600, 86_400, 259_200, 604_800]);
    expect(idlePresetsWithin(NARROW_BOUNDS)).toEqual([]);
  });
});
