import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AutoJudgeGetResponse,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  judgeModelsFailedLine,
  judgeNoModelsLine,
} from "@/components/settings/panels/auto-judge-selection";
import { JudgeTab } from "@/components/settings/panels/permissions/judge-tab";
import {
  harness,
  judgeCatalog,
  model,
  profile,
  provider,
  resetModels,
  setModels,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";

// ---- host boundary --------------------------------------------------------

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () =>
    hostScopeFixture({ status: "following", hostId: "host-a" }),
}));
vi.mock(
  "@/components/settings/host-scope/use-scoped-host-binding",
  async () => {
    const { scopedHostBindingFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    return {
      useScopedHostBinding: (scope: HostScope) =>
        scopedHostBindingFixture(scope),
    };
  },
);
vi.mock("@/hooks/host/use-host-capability-probe", () => ({
  useHostCapabilityProbe: (args: {
    readonly client: unknown;
    readonly stale: boolean;
    readonly incarnation: ReadonlyArray<unknown>;
  }): void => {
    void args;
  },
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer-a",
}));

// Whether the host advertises `autoJudge.get` (tri-state, as the real hook is)
// and `autoJudge.set`.
const support = vi.hoisted((): { get: boolean | null; set: boolean } => ({
  get: true,
  set: true,
}));
// `providers.list` line the pointer reads. `{ major: 9, minor: 1 }` is the
// only version that can report `autoJudge`; 9.0 and `null` must hide it.
const providersListVersion = vi.hoisted(
  (): { current: { major: number; minor: number } | null } => ({
    current: { major: 9, minor: 1 },
  }),
);
// `autoJudge.get` / `autoJudge.set` lines, answered separately from
// `providers.list` above: `1.3` is the line that carries a reasoning effort
// (`autoJudgeGetKnowsReasoningEffort` / `autoJudgeSetStoresReasoningEffort`).
// Both default to `9.1` - the same "no effort" line every other test in this
// file already assumes - and only the "effort footer" suite below moves them.
const autoJudgeGetVersion = vi.hoisted(
  (): { current: { major: number; minor: number } | null } => ({
    current: { major: 9, minor: 1 },
  }),
);
const autoJudgeSetVersion = vi.hoisted(
  (): { current: { major: number; minor: number } | null } => ({
    current: { major: 9, minor: 1 },
  }),
);
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "autoJudge.get" ? support.get : null,
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    method === "autoJudge.set" ? support.set : false,
  useHostMethodSchemaVersion: (_hostId: string | null, method: string) => {
    if (method === "autoJudge.get") return autoJudgeGetVersion.current;
    if (method === "autoJudge.set") return autoJudgeSetVersion.current;
    return providersListVersion.current;
  },
}));

// ---- queries --------------------------------------------------------------

const judgeRecord = vi.hoisted(
  (): { current: AutoJudgeGetResponse | undefined } => ({ current: undefined }),
);
// One record for both readers: the selection's and the current verdict's.
// Their freshness rules are exercised against the real cache in
// `judge-tab-live.test.tsx`.
vi.mock("@/hooks/auto-mode/use-auto-judge-query", () => ({
  useAutoJudgeQuery: () => ({ data: judgeRecord.current, isError: false }),
  useAutoJudgeVerdict: () => judgeRecord.current,
}));

interface SetJudgeCallbacks {
  readonly onSuccess: () => void;
  readonly onError: () => void;
}
const setJudgeMutate = vi.hoisted(() =>
  vi.fn<
    (
      variables: { readonly selection: AutoJudgeSelection | null },
      callbacks: SetJudgeCallbacks,
    ) => void
  >(),
);
vi.mock("@/hooks/auto-mode/use-auto-judge-set-mutation", () => ({
  useAutoJudgeSetMutation: () => ({ mutate: setJudgeMutate, isPending: false }),
}));

// The catalog, the providers list and the host plumbing the REAL
// `HarnessModelPicker` reads, all answering from `judge-test-support`.
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", async () =>
  (await import("./judge-test-support")).guiHarnessCatalogModuleMock(),
);
vi.mock("@/hooks/providers/use-providers-list-query", async () =>
  (await import("./judge-test-support")).providersListModuleMock(),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", async () =>
  (await import("./judge-test-support")).pickerHostMocks.clientForHostId(),
);
vi.mock("@/hooks/host/use-reactive-host-readiness", async () =>
  (
    await import("./judge-test-support")
  ).pickerHostMocks.reactiveHostReadiness(),
);
vi.mock("@/hooks/agent/use-host-reachability", async () =>
  (await import("./judge-test-support")).pickerHostMocks.hostReachability(),
);
vi.mock("@/hooks/host/use-addressable-host-id", async () =>
  (await import("./judge-test-support")).pickerHostMocks.addressableHostId(),
);
vi.mock("@/hooks/host/use-host-directory-list-query", async () =>
  (await import("./judge-test-support")).pickerHostMocks.hostDirectoryList(),
);
vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", async () =>
  (await import("./judge-test-support")).pickerHostMocks.ensurePack(),
);
vi.mock(
  "@/hooks/providers/use-providers-set-profile-enabled-mutation",
  async () =>
    (await import("./judge-test-support")).pickerHostMocks.setProfileEnabled(),
);
vi.mock("@/hooks/rate-limits/use-profile-usage-comparison", async () =>
  (await import("./judge-test-support")).pickerHostMocks.profileUsage(),
);
vi.mock("react-virtuoso", async () =>
  (await import("./judge-test-support")).pickerHostMocks.virtuoso(),
);

const openSettingsMock = vi.hoisted(() =>
  vi.fn<
    (opts: {
      readonly section: string | null;
      readonly resetToGeneral: boolean;
      readonly tab: string | null;
      readonly draft: null;
      readonly hostId: string | null;
    }) => void
  >(),
);
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: openSettingsMock }),
}));

// ---- fixtures -------------------------------------------------------------

const CLAUDE_STORED: AutoJudgeSelection = {
  harnessId: "claude",
  model: "sonnet",
  profileId: null,
  reasoningEffort: null,
};
const CODEX_LAST: AutoJudgeSelection = {
  harnessId: "codex",
  model: "gpt-mini",
  profileId: null,
  reasoningEffort: null,
};

beforeEach(() => {
  support.get = true;
  support.set = true;
  providersListVersion.current = { major: 9, minor: 1 };
  autoJudgeGetVersion.current = { major: 9, minor: 1 };
  autoJudgeSetVersion.current = { major: 9, minor: 1 };
  judgeRecord.current = { selection: null };
  setJudgeMutate.mockReset();
  resetModels();
  judgeCatalog.harnessesStatus = "answered";
  judgeCatalog.harnesses = [
    harness({ id: "claude", label: "Claude Code", nativeAutoJudge: true }),
    harness({
      id: "codex",
      label: "Codex",
      nativeAutoJudge: false,
      judgeDefaultModel: null,
    }),
  ];
  setModels("claude", {
    kind: "ready",
    models: [
      model("claude", "sonnet", "Claude Sonnet", {}),
      model("claude", "opus", "Claude Opus", {}),
    ],
  });
  setModels("codex", {
    kind: "ready",
    models: [model("codex", "gpt-mini", "GPT Mini", {})],
  });
  judgeCatalog.providers = [
    provider("claude-code", [profile("ambient", "ambient")]),
    provider("codex", [profile("ambient", "ambient")]),
  ];
  openSettingsMock.mockReset();
  useProvidersFocusStore.setState({ focusHarnessId: null, focusTab: null });
  useComposerHarnessMemoryStore.getState().resetForTests();
});

afterEach(cleanup);

function renderTab(): void {
  render(
    <SurfaceActivityProvider active>
      <TooltipProvider delayDuration={0}>
        <JudgeTab />
      </TooltipProvider>
    </SurfaceActivityProvider>,
  );
}

// ---- queries over the two tiles -------------------------------------------

function automaticRadio(): HTMLElement {
  return screen.getByRole("radio", { name: /Automatic/ });
}

function pickRadio(): HTMLElement {
  return screen.getByRole("radio", { name: /A model you pick/ });
}

function isChecked(element: HTMLElement): boolean {
  return element.getAttribute("aria-checked") === "true";
}

function face(): HTMLElement {
  return screen.getByTestId("auto-judge-model-face");
}

function faceDimmed(): boolean {
  return face().closest(".opacity-45") !== null;
}

function faceInert(): boolean {
  return face().getAttribute("aria-disabled") === "true";
}

function pickerPanel(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: "Select model" });
}

/** Every `autoJudge.set` selection this test sent. */
function writes(): ReadonlyArray<AutoJudgeSelection | null> {
  return setJudgeMutate.mock.calls.map(([variables]) => variables.selection);
}

/** No write ever carries `model: ""`: a selection is `null` or names a model. */
function expectNoEmptyModelWrite(): void {
  for (const selection of writes()) {
    if (selection !== null) expect(selection.model).not.toBe("");
  }
}

function lastBrokenCatalog(): void {
  judgeCatalog.harnesses = [
    harness({ id: "claude", label: "Claude Code", nativeAutoJudge: true }),
    harness({
      id: "codex",
      label: "Codex",
      judgeDefaultModel: null,
      authStatus: "unauthenticated",
    }),
  ];
}

/**
 * An arrow press the way Radix reads it. Its radio group moves focus in a
 * timeout and checks the radio it lands on only while the arrow is still held,
 * so the key is held across a tick before it is released; a bare
 * `keyboard("{ArrowDown}")` releases it first and Radix never checks anything.
 */
async function pressArrow(
  user: UserEvent,
  key: "ArrowDown" | "ArrowUp" | "ArrowRight" | "ArrowLeft",
): Promise<void> {
  await user.keyboard(`{${key}>}`);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await user.keyboard(`{/${key}}`);
}

/** Rows whose second tile has a last pick that can run, cannot run, or none. */
function lastRuns(): void {
  judgeRecord.current = { selection: null, lastSelection: CLAUDE_STORED };
}
function lastBroken(): void {
  lastBrokenCatalog();
  judgeRecord.current = { selection: null, lastSelection: CODEX_LAST };
}
function noLast(): void {
  judgeRecord.current = { selection: null, lastSelection: null };
}
function picked(): void {
  judgeRecord.current = { selection: CLAUDE_STORED, lastSelection: null };
}

/** Re-renders the tab after the test moved the mocked record or catalog. */
function nudge(): void {
  act(() => {
    setModels("claude", {
      kind: "ready",
      models: [
        model("claude", "sonnet", "Claude Sonnet", {}),
        model("claude", "opus", "Claude Opus", {}),
      ],
    });
  });
}

async function closePicker(user: UserEvent): Promise<void> {
  await user.keyboard("{Escape}");
  await waitFor(() => expect(pickerPanel()).toBeNull());
}

async function switchToCodexAndClose(user: UserEvent): Promise<void> {
  await user.click(face());
  await user.click(await screen.findByRole("tab", { name: /Codex/ }));
  expect(screen.getByTestId("auto-judge-pending-switch")).not.toBeNull();
  await closePicker(user);
}

async function flushTicks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("JudgeTab", () => {
  describe("the tile-state table", () => {
    it("loading: neither tile is checked, both are inert, and no picker is drawn", () => {
      judgeRecord.current = undefined;
      renderTab();

      expect(isChecked(automaticRadio())).toBe(false);
      expect(isChecked(pickRadio())).toBe(false);
      expect(automaticRadio().hasAttribute("disabled")).toBe(true);
      expect(pickRadio().hasAttribute("disabled")).toBe(true);
      expect(screen.queryByTestId("auto-judge-model-face")).toBeNull();

      fireEvent.click(screen.getByTestId("auto-judge-tile-automatic"));
      fireEvent.click(screen.getByTestId("auto-judge-tile-pick"));
      expect(setJudgeMutate).not.toHaveBeenCalled();
    });

    it("picked: the pick tile is checked and its face shows the pick at full opacity, enabled", async () => {
      picked();
      renderTab();

      expect(isChecked(pickRadio())).toBe(true);
      expect(isChecked(automaticRadio())).toBe(false);
      expect(face().textContent).toContain("Claude Sonnet");
      expect(faceDimmed()).toBe(false);
      expect(faceInert()).toBe(false);
      expect(face().tabIndex).toBe(0);
      // The picker is enabled: the face opens it.
      await userEvent.setup().click(face());
      expect(
        await screen.findByRole("dialog", { name: "Select model" }),
      ).not.toBeNull();
      expect(setJudgeMutate).not.toHaveBeenCalled();
    });

    it("last-runs: Automatic is checked and the last pick is shown dimmed, inert, and a click on the face itself brings the pick back instead of opening the picker", async () => {
      lastRuns();
      renderTab();

      expect(isChecked(automaticRadio())).toBe(true);
      expect(isChecked(pickRadio())).toBe(false);
      expect(face().textContent).toContain("Claude Sonnet");
      expect(faceDimmed()).toBe(true);
      expect(faceInert()).toBe(true);
      expect(face().tabIndex).toBe(-1);
      // Native `disabled` would eat the click the tile needs to hear.
      expect(face().hasAttribute("disabled")).toBe(false);
      // The click lands on the face itself, not on the radio (whose handler
      // returns early in last-runs, so it could not tell a live picker from a
      // dead one). jsdom has no Tailwind, so `pointer-events-none` is not
      // applied here and the click reaches the face; what keeps the picker
      // shut is the face being inert. The tile hears it and restores the pick.
      fireEvent.click(face());
      await act(async () => {
        await Promise.resolve();
      });
      expect(pickerPanel()).toBeNull();
      expect(writes()).toEqual([CLAUDE_STORED]);
    });

    it("last-broken: the last pick is shown dimmed with its blocker, and its picker stays enabled", () => {
      lastBroken();
      renderTab();

      expect(isChecked(automaticRadio())).toBe(true);
      expect(face().textContent).toContain("GPT Mini · Signed out");
      expect(faceDimmed()).toBe(true);
      expect(faceInert()).toBe(false);
      expect(face().tabIndex).toBe(0);
    });

    it("no-last: the face reads Choose a model, dimmed, and the picker is enabled", async () => {
      noLast();
      renderTab();

      expect(isChecked(automaticRadio())).toBe(true);
      expect(face().textContent).toContain("Choose a model");
      expect(faceDimmed()).toBe(true);
      expect(faceInert()).toBe(false);
      expect(face().tabIndex).toBe(0);
      await userEvent.setup().click(face());
      expect(
        await screen.findByRole("dialog", { name: "Select model" }),
      ).not.toBeNull();
    });

    it("read-only: the face is at full opacity and inert whatever the row, and nothing writes", () => {
      support.set = false;
      lastRuns();
      renderTab();

      expect(faceDimmed()).toBe(false);
      expect(faceInert()).toBe(true);
      expect(automaticRadio().hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByTestId("auto-judge-tile-pick"));
      fireEvent.click(face());
      expect(setJudgeMutate).not.toHaveBeenCalled();
      expect(pickerPanel()).toBeNull();
    });

    it("read-only, picked: the pick is shown at full opacity, inert", () => {
      support.set = false;
      picked();
      renderTab();

      expect(isChecked(pickRadio())).toBe(true);
      expect(faceDimmed()).toBe(false);
      expect(faceInert()).toBe(true);
    });
  });

  describe("what the host's answer carries", () => {
    it("a 1.1 host (no lastSelection key at all) with nothing picked is the no-last row", () => {
      judgeRecord.current = { selection: null };
      renderTab();

      expect(face().textContent).toContain("Choose a model");
      expect(faceDimmed()).toBe(true);
    });

    it("a 1.2 host's lastSelection is the last pick the second tile shows", () => {
      judgeRecord.current = {
        selection: null,
        lastSelection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: null,
        },
      };
      renderTab();

      expect(face().textContent).toContain("Claude Opus");
      expect(faceDimmed()).toBe(true);
    });
  });

  describe("choosing a tile", () => {
    it("a click on the inert face ITSELF, in last-runs, restores the last pick", async () => {
      lastRuns();
      renderTab();

      await userEvent.setup().click(face());

      expect(writes()).toEqual([CLAUDE_STORED]);
    });

    it("a click on the second tile's radio, in last-runs, restores the last pick", async () => {
      lastRuns();
      renderTab();

      await userEvent.setup().click(pickRadio());

      expect(writes()).toEqual([CLAUDE_STORED]);
    });

    it("a click on the second tile's body, in last-runs, restores the last pick", async () => {
      lastRuns();
      renderTab();

      await userEvent
        .setup()
        .click(screen.getByText(/Always the model you choose/));

      expect(writes()).toEqual([CLAUDE_STORED]);
    });

    it("in last-broken, choosing the second tile opens the picker and writes nothing", async () => {
      lastBroken();
      renderTab();
      const user = userEvent.setup();

      await user.click(screen.getByText(/Always the model you choose/));
      expect(
        await screen.findByRole("dialog", { name: "Select model" }),
      ).not.toBeNull();
      expect(setJudgeMutate).not.toHaveBeenCalled();
    });

    it("in no-last, a click on the radio opens the picker and writes nothing", async () => {
      noLast();
      renderTab();

      await userEvent.setup().click(pickRadio());

      expect(
        await screen.findByRole("dialog", { name: "Select model" }),
      ).not.toBeNull();
      expect(setJudgeMutate).not.toHaveBeenCalled();
    });

    it("a click on a picked tile's own face opens the picker and writes nothing new", async () => {
      picked();
      renderTab();

      await userEvent.setup().click(face());

      expect(
        await screen.findByRole("dialog", { name: "Select model" }),
      ).not.toBeNull();
      expect(setJudgeMutate).not.toHaveBeenCalled();
    });

    it("choosing Automatic, by tile or radio, writes a null selection when a pick is stored", async () => {
      picked();
      renderTab();
      const user = userEvent.setup();

      await user.click(screen.getByTestId("auto-judge-tile-automatic"));

      expect(writes()).toEqual([null]);
    });

    it("choosing Automatic writes nothing when Automatic is already displayed", async () => {
      lastRuns();
      renderTab();
      const user = userEvent.setup();

      await user.click(automaticRadio());
      await user.click(screen.getByTestId("auto-judge-tile-automatic"));

      expect(setJudgeMutate).not.toHaveBeenCalled();
    });

    it("while the switch to Automatic is still saving, the second tile shows the just-cleared pick dimmed, at once", async () => {
      // No `lastSelection` yet: the record's own selection is the pick being
      // cleared, and the cached record says nothing else until the echo lands.
      judgeRecord.current = { selection: CLAUDE_STORED };
      renderTab();

      await userEvent
        .setup()
        .click(screen.getByTestId("auto-judge-tile-automatic"));

      // The mutation is held: `onSuccess` has not run.
      expect(setJudgeMutate).toHaveBeenCalledTimes(1);
      expect(isChecked(automaticRadio())).toBe(true);
      expect(face().textContent).toContain("Claude Sonnet");
      expect(face().textContent).not.toContain("Choose a model");
      expect(faceDimmed()).toBe(true);
      expect(screen.getByTestId("auto-judge-saving")).not.toBeNull();
    });

    it("a refused write snaps the tiles back to the stored record", async () => {
      picked();
      renderTab();

      await userEvent
        .setup()
        .click(screen.getByTestId("auto-judge-tile-automatic"));
      expect(isChecked(automaticRadio())).toBe(true);

      act(() => {
        setJudgeMutate.mock.calls[0][1].onError();
      });

      expect(isChecked(pickRadio())).toBe(true);
      expect(isChecked(automaticRadio())).toBe(false);
      expect(face().textContent).toContain("Claude Sonnet");
    });
  });

  describe("the keyboard", () => {
    it("an arrow from Automatic onto the second tile, in last-runs, restores the last pick", async () => {
      lastRuns();
      renderTab();
      const user = userEvent.setup();

      act(() => {
        automaticRadio().focus();
      });
      await pressArrow(user, "ArrowDown");

      expect(writes()).toEqual([CLAUDE_STORED]);
    });

    it("ArrowRight does the same", async () => {
      lastRuns();
      renderTab();
      const user = userEvent.setup();

      act(() => {
        automaticRadio().focus();
      });
      await pressArrow(user, "ArrowRight");

      expect(writes()).toEqual([CLAUDE_STORED]);
    });

    it.each([
      ["last-broken", lastBroken],
      ["no-last", noLast],
    ])(
      "an arrow onto the second tile in %s only moves focus: no write, no picker",
      async (_row, setUp) => {
        setUp();
        renderTab();
        const user = userEvent.setup();

        act(() => {
          automaticRadio().focus();
        });
        await pressArrow(user, "ArrowDown");

        expect(document.activeElement).toBe(pickRadio());
        expect(setJudgeMutate).not.toHaveBeenCalled();
        expect(pickerPanel()).toBeNull();
      },
    );

    it.each([
      ["last-broken", "Space", lastBroken, " "],
      ["last-broken", "Enter", lastBroken, "{Enter}"],
      ["no-last", "Space", noLast, " "],
      ["no-last", "Enter", noLast, "{Enter}"],
    ])(
      "%s: %s on the focused second-tile radio opens the picker",
      async (_row, _keyName, setUp, key) => {
        setUp();
        renderTab();
        const user = userEvent.setup();

        act(() => {
          pickRadio().focus();
        });
        await user.keyboard(key);

        expect(
          await screen.findByRole("dialog", { name: "Select model" }),
        ).not.toBeNull();
        expect(setJudgeMutate).not.toHaveBeenCalled();
      },
    );

    it("an arrow from the picked tile onto Automatic writes a null selection", async () => {
      picked();
      renderTab();
      const user = userEvent.setup();

      act(() => {
        pickRadio().focus();
      });
      await pressArrow(user, "ArrowUp");

      expect(writes()).toEqual([null]);
    });

    it("the face is a Tab stop when enabled, and skipped when inert", async () => {
      picked();
      renderTab();
      const user = userEvent.setup();
      act(() => {
        pickRadio().focus();
      });
      await user.tab();
      expect(document.activeElement).toBe(face());

      cleanup();
      lastRuns();
      renderTab();
      act(() => {
        pickRadio().focus();
      });
      await user.tab();
      expect(document.activeElement).not.toBe(face());
    });
  });

  describe("the Automatic status line", () => {
    it("says no judge can run when effective is null", () => {
      judgeRecord.current = { selection: null, effective: null };
      renderTab();

      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        "No judge can run here · Auto mode asks you",
      );
    });

    it("names each conversation's own model for a fallback", () => {
      judgeRecord.current = {
        selection: null,
        effective: { source: "fallback" },
      };
      renderTab();

      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        "Now: each conversation's own model · on your account there",
      );
    });

    it("names the model on Traycer, with credits, for the hosted default", () => {
      judgeCatalog.harnesses = [harness({ id: "traycer", label: "Traycer" })];
      setModels("traycer", {
        kind: "ready",
        models: [model("traycer", "haiku", "Claude Haiku", {})],
      });
      judgeRecord.current = {
        selection: null,
        effective: { source: "default", harnessId: "traycer", model: "haiku" },
      };
      renderTab();

      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        "Now: Claude Haiku on Traycer · uses Traycer credits",
      );
    });

    it("stays silent when the host reports no effective judge", () => {
      judgeRecord.current = { selection: null };
      renderTab();

      expect(screen.queryByTestId("auto-judge-effective")).toBeNull();
    });

    it("is shown only while Automatic is selected, and not while its switch saves", async () => {
      judgeRecord.current = {
        selection: CLAUDE_STORED,
        effective: {
          source: "selection",
          harnessId: "claude",
          model: "sonnet",
        },
      };
      renderTab();
      expect(screen.queryByTestId("auto-judge-effective")).toBeNull();

      await userEvent
        .setup()
        .click(screen.getByTestId("auto-judge-tile-automatic"));

      expect(screen.getByTestId("auto-judge-saving")).not.toBeNull();
      expect(screen.queryByTestId("auto-judge-effective")).toBeNull();
    });
  });

  describe("the second tile's status line", () => {
    it("names who is billed for a picked model that can run", () => {
      judgeRecord.current = {
        selection: CLAUDE_STORED,
        effective: {
          source: "selection",
          harnessId: "claude",
          model: "sonnet",
        },
      };
      renderTab();

      expect(screen.getByTestId("auto-judge-picked-status").textContent).toBe(
        "Billed to your Claude Code account",
      );
    });

    it("names the account when the provider has more than one", () => {
      judgeCatalog.providers = [
        provider("claude-code", [
          profile("ambient", "ambient"),
          profile("work", "managed"),
        ]),
        provider("codex", [profile("ambient", "ambient")]),
      ];
      judgeRecord.current = {
        selection: { ...CLAUDE_STORED, profileId: "work" },
        effective: {
          source: "selection",
          harnessId: "claude",
          model: "sonnet",
        },
      };
      renderTab();

      expect(screen.getByTestId("auto-judge-picked-status").textContent).toBe(
        "Billed to your Claude Code account (work)",
      );
      // The chip names it under the same rule.
      expect(face().textContent).toContain("work");
    });

    it("names no account when the provider has one", () => {
      judgeRecord.current = {
        selection: CLAUDE_STORED,
        effective: {
          source: "selection",
          harnessId: "claude",
          model: "sonnet",
        },
      };
      renderTab();

      expect(face().textContent).not.toContain("ambient");
    });

    it("shows the spinner alone while a pick saves", async () => {
      picked();
      renderTab();
      const user = userEvent.setup();
      await user.click(face());
      await user.click(
        await screen.findByRole("option", { name: /Claude Opus/ }),
      );

      expect(writes()).toEqual([
        {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: null,
        },
      ]);
      expect(screen.getByTestId("auto-judge-saving")).not.toBeNull();
      expect(screen.queryByTestId("auto-judge-picked-status")).toBeNull();
    });

    it("warns, with Until then, for a stored provider that is turned off, and links Providers", () => {
      judgeCatalog.harnesses = [
        harness({ id: "claude", label: "Claude Code" }),
        harness({ id: "codex", label: "Codex", enabled: false }),
      ];
      judgeRecord.current = {
        selection: {
          harnessId: "codex",
          model: "gpt-mini",
          profileId: null,
          reasoningEffort: null,
        },
      };
      renderTab();

      const warning = screen.getByTestId("auto-judge-warning");
      expect(warning.textContent).toContain("Codex is turned off");
      expect(screen.getByTestId("auto-judge-warning-until").textContent).toBe(
        "Until then, Auto mode asks you.",
      );

      fireEvent.click(
        within(warning).getByRole("button", { name: "Providers" }),
      );

      expect(useProvidersFocusStore.getState().focusHarnessId).toBe("codex");
      expect(openSettingsMock).toHaveBeenCalledTimes(1);
      expect(openSettingsMock).toHaveBeenCalledWith({
        section: "providers",
        resetToGeneral: false,
        tab: null,
        draft: null,
        hostId: null,
      });
    });

    it("says the harness is unsupported, with no Until then", () => {
      judgeRecord.current = {
        selection: CLAUDE_STORED,
        blocked: { reason: "unsupported-harness" },
      };
      renderTab();

      expect(screen.getByTestId("auto-judge-warning").textContent).toContain(
        "can't run a judge on Claude Code",
      );
      expect(screen.queryByTestId("auto-judge-warning-until")).toBeNull();
    });

    it("adds the Copilot premium-requests line for a Copilot pick", () => {
      judgeCatalog.harnesses = [
        ...judgeCatalog.harnesses,
        harness({ id: "copilot", label: "Copilot" }),
      ];
      setModels("copilot", {
        kind: "ready",
        models: [model("copilot", "gpt-5", "GPT 5", {})],
      });
      judgeCatalog.providers = [
        ...(judgeCatalog.providers ?? []),
        provider("copilot", [profile("ambient", "ambient")]),
      ];
      judgeRecord.current = {
        selection: {
          harnessId: "copilot",
          model: "gpt-5",
          profileId: null,
          reasoningEffort: null,
        },
        effective: {
          source: "selection",
          harnessId: "copilot",
          model: "gpt-5",
        },
      };
      renderTab();

      expect(screen.getByTestId("auto-judge-copilot-picked")).not.toBeNull();
    });
  });

  describe("a provider switch waiting for its models", () => {
    beforeEach(() => {
      picked();
      // Codex names no default model, so switching to it commits `""`, which
      // only its catalog can resolve.
      setModels("codex", { kind: "pending" });
    });

    async function switchToCodex(): Promise<UserEvent> {
      renderTab();
      const user = userEvent.setup();
      await user.click(face());
      await user.click(await screen.findByRole("tab", { name: /Codex/ }));
      return user;
    }

    function pendingLine(): HTMLElement {
      return screen.getByTestId("auto-judge-pending-switch");
    }

    it("loading: shows the spinner line and writes nothing; closing keeps the switch, and the models landing saves the catalog default once", async () => {
      const user = await switchToCodex();

      expect(pendingLine().textContent).toContain("Waiting for Codex's models");
      expect(setJudgeMutate).not.toHaveBeenCalled();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(pickerPanel()).toBeNull());
      expect(pendingLine()).not.toBeNull();
      expect(setJudgeMutate).not.toHaveBeenCalled();

      act(() => {
        setModels("codex", {
          kind: "ready",
          models: [model("codex", "gpt-mini", "GPT Mini", {})],
        });
      });

      await waitFor(() => expect(setJudgeMutate).toHaveBeenCalledTimes(1));
      expect(writes()).toEqual([
        {
          harnessId: "codex",
          model: "gpt-mini",
          profileId: null,
          reasoningEffort: null,
        },
      ]);
      expectNoEmptyModelWrite();
    });

    it("empty: says the provider offers no models, and closing re-seeds to the saved pick with no write", async () => {
      const user = await switchToCodex();

      act(() => {
        setModels("codex", { kind: "ready", models: [] });
      });
      expect(pendingLine().textContent).toBe(judgeNoModelsLine("Codex"));

      await user.keyboard("{Escape}");
      await waitFor(() => expect(pickerPanel()).toBeNull());

      await waitFor(() =>
        expect(screen.queryByTestId("auto-judge-pending-switch")).toBeNull(),
      );
      expect(face().textContent).toContain("Claude Sonnet");
      expect(setJudgeMutate).not.toHaveBeenCalled();
    });

    it("failed: says the read failed, and closing re-seeds to the saved pick with no write", async () => {
      const user = await switchToCodex();

      act(() => {
        setModels("codex", { kind: "error" });
      });
      expect(pendingLine().textContent).toBe(judgeModelsFailedLine("Codex"));

      await user.keyboard("{Escape}");
      await waitFor(() => expect(pickerPanel()).toBeNull());

      await waitFor(() =>
        expect(screen.queryByTestId("auto-judge-pending-switch")).toBeNull(),
      );
      expect(face().textContent).toContain("Claude Sonnet");
      expect(setJudgeMutate).not.toHaveBeenCalled();
    });

    it("a provider that names a default model commits it at once, never an empty one", async () => {
      judgeCatalog.harnesses = [
        harness({ id: "claude", label: "Claude Code", nativeAutoJudge: true }),
        harness({ id: "codex", label: "Codex", judgeDefaultModel: "gpt-mini" }),
      ];
      renderTab();
      const user = userEvent.setup();
      await user.click(face());
      await user.click(await screen.findByRole("tab", { name: /Codex/ }));

      expect(writes()).toEqual([
        {
          harnessId: "codex",
          model: "gpt-mini",
          profileId: null,
          reasoningEffort: null,
        },
      ]);
      expectNoEmptyModelWrite();
    });
  });

  describe("composer memory", () => {
    it("a judge pick leaves the composer's harness memory untouched", async () => {
      picked();
      judgeCatalog.harnesses = [
        harness({ id: "claude", label: "Claude Code", nativeAutoJudge: true }),
        harness({ id: "codex", label: "Codex", judgeDefaultModel: "gpt-mini" }),
      ];
      const before = useComposerHarnessMemoryStore.getState();
      const listener = vi.fn();
      const unsubscribe = useComposerHarnessMemoryStore.subscribe(listener);
      renderTab();
      const user = userEvent.setup();

      await user.click(face());
      await user.click(
        await screen.findByRole("option", { name: /Claude Opus/ }),
      );
      await user.click(await screen.findByRole("tab", { name: /Codex/ }));
      unsubscribe();

      expect(writes()).toHaveLength(2);
      expect(listener).not.toHaveBeenCalled();
      expect(useComposerHarnessMemoryStore.getState()).toBe(before);
      expect(useComposerHarnessMemoryStore.getState().byHost).toEqual({});
    });
  });

  describe("the built-in reviewer pointer", () => {
    const CLAUDE_POINTER =
      "Claude Code conversations are checked by Claude's own reviewer, not this judge.";
    const CODEX_POINTER =
      "Codex conversations are checked by Codex's own reviewer, not this judge.";
    const PLURAL_POINTER =
      "Claude Code and Codex conversations are checked by their own reviewers, not this judge.";
    const OPEN_PROVIDERS = {
      section: "providers",
      resetToGeneral: false,
      tab: null,
      draft: null,
      hostId: null,
    } as const;

    function claudeWithJudge(
      autoJudge: ProviderCliState["autoJudge"],
    ): ProviderCliState {
      return {
        ...provider("claude-code", [profile("ambient", "ambient")]),
        autoJudge,
      };
    }

    function selfReviewingClaude(): void {
      judgeCatalog.providers = [
        claudeWithJudge("provider"),
        provider("codex", [profile("ambient", "ambient")]),
      ];
    }

    it("is hidden when no provider has a native reviewer", () => {
      judgeCatalog.harnesses = judgeCatalog.harnesses.map((row) => ({
        ...row,
        nativeAutoJudge: false,
      }));
      selfReviewingClaude();
      renderTab();

      expect(screen.queryByTestId("auto-judge-reviewer-pointer")).toBeNull();
    });

    it("is hidden when the native provider is set to Traycer's judge", () => {
      judgeCatalog.providers = [
        claudeWithJudge("traycer"),
        provider("codex", [profile("ambient", "ambient")]),
      ];
      renderTab();

      expect(screen.queryByTestId("auto-judge-reviewer-pointer")).toBeNull();
    });

    it("is hidden when the native provider's autoJudge is absent", () => {
      renderTab();

      expect(screen.queryByTestId("auto-judge-reviewer-pointer")).toBeNull();
    });

    it("is hidden on a providers.list 9.0 line even when the state says provider", () => {
      providersListVersion.current = { major: 9, minor: 0 };
      selfReviewingClaude();
      renderTab();

      expect(screen.queryByTestId("auto-judge-reviewer-pointer")).toBeNull();
    });

    it("is hidden when the providers.list version is unknown even when the state says provider", () => {
      providersListVersion.current = null;
      selfReviewingClaude();
      renderTab();

      expect(screen.queryByTestId("auto-judge-reviewer-pointer")).toBeNull();
    });

    it("is hidden while the harness catalog is pending", () => {
      judgeCatalog.harnessesStatus = "pending";
      selfReviewingClaude();
      renderTab();

      expect(screen.queryByTestId("auto-judge-reviewer-pointer")).toBeNull();
    });

    it("is hidden while providers.list is loading", () => {
      selfReviewingClaude();
      judgeCatalog.providers = undefined;
      renderTab();

      expect(screen.queryByTestId("auto-judge-reviewer-pointer")).toBeNull();
    });

    it("names Claude as the owner for a single Claude Code reviewer", () => {
      selfReviewingClaude();
      renderTab();

      const pointer = screen.getByTestId("auto-judge-reviewer-pointer");
      expect(pointer.textContent).toBe(
        `${CLAUDE_POINTER} Change in Providers ▸ Claude Code`,
      );
      expect(
        screen.getByRole("button", {
          name: "Change in Providers ▸ Claude Code",
        }),
      ).not.toBeNull();
      expect(
        screen.getByTestId("auto-judge-reviewer-pointer-claude"),
      ).not.toBeNull();
    });

    it("names the provider's own label as the owner for a non-Claude native reviewer", () => {
      judgeCatalog.harnesses = [
        harness({ id: "claude", label: "Claude Code", nativeAutoJudge: false }),
        harness({
          id: "codex",
          label: "Codex",
          nativeAutoJudge: true,
          judgeDefaultModel: "gpt-mini",
        }),
      ];
      judgeCatalog.providers = [
        provider("claude-code", [profile("ambient", "ambient")]),
        {
          ...provider("codex", [profile("ambient", "ambient")]),
          autoJudge: "provider",
        },
      ];
      renderTab();

      expect(
        screen.getByTestId("auto-judge-reviewer-pointer").textContent,
      ).toContain(CODEX_POINTER);
      expect(
        screen.getByRole("button", { name: "Change in Providers ▸ Codex" }),
      ).not.toBeNull();
    });

    it("lists each self-reviewing provider in catalog order, with one link apiece", () => {
      judgeCatalog.harnesses = [
        harness({ id: "claude", label: "Claude Code", nativeAutoJudge: true }),
        harness({
          id: "codex",
          label: "Codex",
          nativeAutoJudge: true,
          judgeDefaultModel: "gpt-mini",
        }),
      ];
      judgeCatalog.providers = [
        claudeWithJudge("provider"),
        {
          ...provider("codex", [profile("ambient", "ambient")]),
          autoJudge: "provider",
        },
      ];
      renderTab();

      const pointer = screen.getByTestId("auto-judge-reviewer-pointer");
      expect(pointer.textContent).toBe(
        `${PLURAL_POINTER} Change in Providers ▸ Claude Code · Change in Providers ▸ Codex`,
      );
      expect(
        screen.getByRole("button", {
          name: "Change in Providers ▸ Claude Code",
        }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Change in Providers ▸ Codex" }),
      ).not.toBeNull();
    });

    it("opens Providers on the Permissions tab focused on the named provider", () => {
      selfReviewingClaude();
      renderTab();

      fireEvent.click(
        screen.getByRole("button", {
          name: "Change in Providers ▸ Claude Code",
        }),
      );

      expect(useProvidersFocusStore.getState().focusHarnessId).toBe("claude");
      expect(useProvidersFocusStore.getState().focusTab).toBe("permissions");
      expect(openSettingsMock).toHaveBeenCalledTimes(1);
      expect(openSettingsMock).toHaveBeenCalledWith(OPEN_PROVIDERS);
    });

    it("opens the second provider's Permissions tab from its own link", () => {
      judgeCatalog.harnesses = [
        harness({ id: "claude", label: "Claude Code", nativeAutoJudge: true }),
        harness({
          id: "codex",
          label: "Codex",
          nativeAutoJudge: true,
          judgeDefaultModel: "gpt-mini",
        }),
      ];
      judgeCatalog.providers = [
        claudeWithJudge("provider"),
        {
          ...provider("codex", [profile("ambient", "ambient")]),
          autoJudge: "provider",
        },
      ];
      renderTab();

      fireEvent.click(
        screen.getByRole("button", { name: "Change in Providers ▸ Codex" }),
      );

      expect(useProvidersFocusStore.getState().focusHarnessId).toBe("codex");
      expect(useProvidersFocusStore.getState().focusTab).toBe("permissions");
      expect(openSettingsMock).toHaveBeenCalledTimes(1);
      expect(openSettingsMock).toHaveBeenCalledWith(OPEN_PROVIDERS);
    });
  });

  describe("review round 1", () => {
    const OPUS: AutoJudgeSelection = {
      harnessId: "claude",
      model: "opus",
      profileId: null,
      reasoningEffort: null,
    };

    describe("R1: a choice made on the card ends a pending switch", () => {
      beforeEach(() => {
        setModels("codex", { kind: "pending" });
      });

      it("P1: a later click on Automatic wins over a switch still waiting for its models", async () => {
        judgeRecord.current = {
          selection: CLAUDE_STORED,
          lastSelection: CLAUDE_STORED,
        };
        renderTab();
        const user = userEvent.setup();
        await switchToCodexAndClose(user);

        await user.click(screen.getByTestId("auto-judge-tile-automatic"));
        expect(writes()).toEqual([null]);

        act(() => {
          setJudgeMutate.mock.calls[0][1].onSuccess();
        });
        judgeRecord.current = {
          selection: null,
          lastSelection: CLAUDE_STORED,
        };
        nudge();
        act(() => {
          setModels("codex", {
            kind: "ready",
            models: [model("codex", "gpt-mini", "GPT Mini", {})],
          });
        });
        await flushTicks();

        expect(writes()).toEqual([null]);
      });

      it("Automatic already on: choosing it again still ends the pending switch", async () => {
        judgeRecord.current = { selection: CLAUDE_STORED };
        renderTab();
        const user = userEvent.setup();
        await switchToCodexAndClose(user);
        // Another window moves the judge to Automatic: nothing to write here.
        judgeRecord.current = { selection: null, lastSelection: CLAUDE_STORED };
        nudge();

        await user.click(screen.getByTestId("auto-judge-tile-automatic"));
        expect(setJudgeMutate).not.toHaveBeenCalled();
        act(() => {
          setModels("codex", {
            kind: "ready",
            models: [model("codex", "gpt-mini", "GPT Mini", {})],
          });
        });
        await flushTicks();

        expect(writes()).toEqual([]);
      });

      it("◎: restoring the last pick from its tile ends the pending switch", async () => {
        judgeRecord.current = { selection: CLAUDE_STORED };
        renderTab();
        const user = userEvent.setup();
        await switchToCodexAndClose(user);
        // Another window moves the judge to Automatic; the row is now last-runs.
        judgeRecord.current = { selection: null, lastSelection: CLAUDE_STORED };
        nudge();
        expect(faceDimmed()).toBe(true);

        await user.click(screen.getByText(/Always the model you choose/));
        expect(writes()).toEqual([CLAUDE_STORED]);
        act(() => {
          setModels("codex", {
            kind: "ready",
            models: [model("codex", "gpt-mini", "GPT Mini", {})],
          });
        });
        await flushTicks();

        expect(writes()).toEqual([CLAUDE_STORED]);
      });
    });

    describe("R2: a click that names the pick already on show writes nothing", () => {
      it("P2: re-clicking the selected provider keeps its model and writes nothing", async () => {
        judgeRecord.current = { selection: OPUS };
        renderTab();
        const user = userEvent.setup();

        await user.click(face());
        await user.click(await screen.findByRole("tab", { name: /Claude/ }));

        expect(writes()).toEqual([]);
        expect(face().textContent).toContain("Claude Opus");
      });

      it("clicking the already-checked model row writes nothing", async () => {
        judgeRecord.current = { selection: OPUS };
        renderTab();
        const user = userEvent.setup();

        await user.click(face());
        await user.click(
          await screen.findByRole("option", { name: /Claude Opus/ }),
        );

        expect(writes()).toEqual([]);
      });
    });

    describe("R3: a pending switch that cannot save is settled behind a closed picker", () => {
      beforeEach(() => {
        setModels("codex", { kind: "pending" });
      });

      function moveJudgeToOpus(): void {
        judgeRecord.current = {
          selection: OPUS,
          effective: {
            source: "selection",
            harnessId: "claude",
            model: "opus",
          },
        };
        nudge();
      }

      async function expectOpusOnShowAndNextOpen(
        user: UserEvent,
      ): Promise<void> {
        await flushTicks();
        expect(screen.queryByTestId("auto-judge-pending-switch")).toBeNull();
        expect(face().textContent).toContain("Claude Opus");
        expect(screen.getByTestId("auto-judge-picked-status").textContent).toBe(
          "Billed to your Claude Code account",
        );
        expect(setJudgeMutate).not.toHaveBeenCalled();

        // The next open starts from the machine's judge, not from Codex.
        await user.click(face());
        await screen.findByRole("dialog", { name: "Select model" });
        expect(
          screen
            .getByRole("tab", { name: /Claude/ })
            .getAttribute("aria-selected"),
        ).toBe("true");
        expect(
          screen
            .getByRole("option", { name: /Claude Opus/ })
            .getAttribute("aria-selected"),
        ).toBe("true");
      }

      it("P4: models that fail after the close settle the switch, and the judge another window set shows", async () => {
        judgeRecord.current = { selection: CLAUDE_STORED };
        renderTab();
        const user = userEvent.setup();
        await switchToCodexAndClose(user);

        act(() => {
          setModels("codex", { kind: "error" });
        });
        moveJudgeToOpus();

        await expectOpusOnShowAndNextOpen(user);
      });

      it("models that arrive empty after the close settle the switch the same way", async () => {
        judgeRecord.current = { selection: CLAUDE_STORED };
        renderTab();
        const user = userEvent.setup();
        await switchToCodexAndClose(user);

        act(() => {
          setModels("codex", { kind: "ready", models: [] });
        });
        moveJudgeToOpus();

        await expectOpusOnShowAndNextOpen(user);
      });

      it("a provider that stops being available settles the switch, and coming back with models writes nothing", async () => {
        judgeRecord.current = { selection: CLAUDE_STORED };
        renderTab();
        const user = userEvent.setup();
        await switchToCodexAndClose(user);

        judgeCatalog.harnesses = [
          harness({
            id: "claude",
            label: "Claude Code",
            nativeAutoJudge: true,
          }),
          harness({
            id: "codex",
            label: "Codex",
            judgeDefaultModel: null,
            available: false,
          }),
        ];
        nudge();
        await flushTicks();
        expect(screen.queryByTestId("auto-judge-pending-switch")).toBeNull();

        judgeCatalog.harnesses = [
          harness({
            id: "claude",
            label: "Claude Code",
            nativeAutoJudge: true,
          }),
          harness({ id: "codex", label: "Codex", judgeDefaultModel: null }),
        ];
        act(() => {
          setModels("codex", {
            kind: "ready",
            models: [model("codex", "gpt-mini", "GPT Mini", {})],
          });
        });
        await flushTicks();

        expect(writes()).toEqual([]);
        expect(face().textContent).toContain("Claude Sonnet");
      });
    });

    describe("R4: a pick still saving stays on show when Automatic is chosen", () => {
      it("P3: pick, then Automatic before the write lands, reads the pick dimmed, never Choose a model", async () => {
        judgeRecord.current = { selection: null, lastSelection: null };
        renderTab();
        const user = userEvent.setup();

        await user.click(face());
        await user.click(await screen.findByRole("tab", { name: /Claude/ }));
        expect(writes()).toHaveLength(1);
        await closePicker(user);

        await user.click(screen.getByTestId("auto-judge-tile-automatic"));

        expect(writes()).toHaveLength(2);
        expect(writes()[1]).toBeNull();
        expect(face().textContent).toContain("Claude Sonnet");
        expect(face().textContent).not.toContain("Choose a model");
        expect(faceDimmed()).toBe(true);
      });
    });

    describe("R6: a stored harness this build does not know marks no row", () => {
      it("opens the picker with no model row checked", async () => {
        judgeRecord.current = {
          selection: {
            harnessId: "mystery",
            model: "m",
            profileId: null,
            reasoningEffort: null,
          },
        };
        renderTab();

        await userEvent.setup().click(face());
        await screen.findByRole("dialog", { name: "Select model" });

        const rows = screen.getAllByRole("option");
        expect(rows.length).toBeGreaterThan(0);
        expect(
          rows.filter((row) => row.getAttribute("aria-selected") === "true"),
        ).toEqual([]);
      });
    });

    describe("R7: the card waits for the lists a last pick is judged from", () => {
      function expectLoadingAndInert(): void {
        expect(automaticRadio().hasAttribute("disabled")).toBe(true);
        expect(pickRadio().hasAttribute("disabled")).toBe(true);
        expect(screen.queryByTestId("auto-judge-model-face")).toBeNull();
        fireEvent.click(screen.getByTestId("auto-judge-tile-automatic"));
        fireEvent.click(screen.getByTestId("auto-judge-tile-pick"));
        expect(setJudgeMutate).not.toHaveBeenCalled();
      }

      async function expectLastBrokenOpensPicker(): Promise<void> {
        expect(isChecked(automaticRadio())).toBe(true);
        expect(faceDimmed()).toBe(true);
        expect(faceInert()).toBe(false);
        await userEvent
          .setup()
          .click(screen.getByText(/Always the model you choose/));
        expect(
          await screen.findByRole("dialog", { name: "Select model" }),
        ).not.toBeNull();
        expect(setJudgeMutate).not.toHaveBeenCalled();
      }

      it("stays loading until the harness list answers, then treats a signed-out last pick as broken: the picker opens and nothing is written", async () => {
        lastBrokenCatalog();
        judgeCatalog.harnessesStatus = "pending";
        judgeRecord.current = { selection: null, lastSelection: CODEX_LAST };
        renderTab();

        expectLoadingAndInert();

        judgeCatalog.harnessesStatus = "answered";
        nudge();

        expect(face().textContent).toContain("Signed out");
        await expectLastBrokenOpensPicker();
      });

      it("stays loading until the providers list answers, then treats a last pick on a removed account as broken: the picker opens and nothing is written", async () => {
        judgeCatalog.providers = undefined;
        judgeRecord.current = {
          selection: null,
          lastSelection: { ...CODEX_LAST, profileId: "work" },
        };
        renderTab();

        expectLoadingAndInert();

        judgeCatalog.providers = [
          provider("claude-code", [profile("ambient", "ambient")]),
          provider("codex", [profile("ambient", "ambient")]),
        ];
        nudge();

        await expectLastBrokenOpensPicker();
      });

      it("a failed harness list does not keep the card loading", () => {
        judgeCatalog.harnessesStatus = "failed";
        picked();
        renderTab();

        expect(automaticRadio().hasAttribute("disabled")).toBe(false);
        expect(pickRadio().hasAttribute("disabled")).toBe(false);
      });
    });
  });

  describe("review round 2", () => {
    const CODEX_OLD: AutoJudgeSelection = {
      harnessId: "codex",
      model: "gpt-old",
      profileId: null,
      reasoningEffort: null,
    };
    const CODEX_GPT_MINI: AutoJudgeSelection = {
      harnessId: "codex",
      model: "gpt-mini",
      profileId: null,
      reasoningEffort: null,
    };

    describe("N1: re-clicking a provider keeps its model only while the catalog lists it", () => {
      it("P5: last-broken on a delisted Codex model, re-clicking Codex saves the recommended model, never the delisted one", async () => {
        judgeRecord.current = { selection: null, lastSelection: CODEX_OLD };
        renderTab();
        const user = userEvent.setup();

        await user.click(screen.getByText(/Always the model you choose/));
        await screen.findByRole("dialog", { name: "Select model" });
        await user.click(await screen.findByRole("tab", { name: /Codex/ }));

        expect(writes()).not.toContainEqual(CODEX_OLD);
        expect(writes()).toEqual([CODEX_GPT_MINI]);
      });

      it("P5b: picked on a delisted Codex model, re-clicking Codex writes the recommended model exactly once", async () => {
        judgeRecord.current = { selection: CODEX_OLD };
        renderTab();
        const user = userEvent.setup();

        await user.click(face());
        await screen.findByRole("dialog", { name: "Select model" });
        await user.click(await screen.findByRole("tab", { name: /Codex/ }));

        expect(writes()).toEqual([CODEX_GPT_MINI]);
      });

      it("P2: re-clicking a listed provider stays a no-op", async () => {
        const OPUS: AutoJudgeSelection = {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: null,
        };
        judgeRecord.current = { selection: OPUS };
        renderTab();
        const user = userEvent.setup();

        await user.click(face());
        await user.click(await screen.findByRole("tab", { name: /Claude/ }));

        expect(writes()).toEqual([]);
        expect(face().textContent).toContain("Claude Opus");
      });

      it("F1: re-clicking the provider already selected while its models still load keeps the stored model", async () => {
        const OPUS: AutoJudgeSelection = {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: null,
        };
        setModels("claude", { kind: "pending" });
        judgeRecord.current = { selection: OPUS };
        renderTab();
        const user = userEvent.setup();

        await user.click(face());
        await user.click(await screen.findByRole("tab", { name: /Claude/ }));
        act(() => {
          setModels("claude", {
            kind: "ready",
            models: [
              model("claude", "sonnet", "Claude Sonnet", {}),
              model("claude", "opus", "Claude Opus", {}),
            ],
          });
        });
        await flushTicks();

        expect(writes()).toEqual([]);
        expect(face().textContent).toContain("Claude Opus");
      });
    });

    describe("N2: the checked Automatic radio's own click ends a pending switch", () => {
      beforeEach(() => {
        setModels("codex", { kind: "pending" });
      });

      it("P6: a click on the already-checked Automatic radio circle ends a switch still waiting for its models", async () => {
        judgeRecord.current = { selection: CLAUDE_STORED };
        renderTab();
        const user = userEvent.setup();
        await switchToCodexAndClose(user);

        // Another window moves the judge to Automatic while Codex still
        // waits for its models.
        judgeRecord.current = {
          selection: null,
          lastSelection: CLAUDE_STORED,
        };
        nudge();
        expect(isChecked(automaticRadio())).toBe(true);

        await user.click(automaticRadio());
        act(() => {
          setModels("codex", {
            kind: "ready",
            models: [model("codex", "gpt-mini", "GPT Mini", {})],
          });
        });
        await flushTicks();

        expect(writes()).toEqual([]);
      });

      it("Space on the focused, already-checked Automatic radio ends the switch the same way", async () => {
        judgeRecord.current = { selection: CLAUDE_STORED };
        renderTab();
        const user = userEvent.setup();
        await switchToCodexAndClose(user);

        judgeRecord.current = {
          selection: null,
          lastSelection: CLAUDE_STORED,
        };
        nudge();
        expect(isChecked(automaticRadio())).toBe(true);

        act(() => {
          automaticRadio().focus();
        });
        await user.keyboard(" ");
        act(() => {
          setModels("codex", {
            kind: "ready",
            models: [model("codex", "gpt-mini", "GPT Mini", {})],
          });
        });
        await flushTicks();

        expect(writes()).toEqual([]);
      });
    });

    describe("N3: the already-selected pick tile does not end a pending switch", () => {
      beforeEach(() => {
        setModels("codex", { kind: "pending" });
      });

      it("P7: pins existing behaviour - a click on the already-selected pick tile body does not end a switch, which still lands once its models arrive", async () => {
        judgeRecord.current = { selection: CLAUDE_STORED };
        renderTab();
        const user = userEvent.setup();
        await switchToCodexAndClose(user);

        await user.click(screen.getByText(/Always the model you choose/));
        expect(screen.getByTestId("auto-judge-pending-switch")).not.toBeNull();

        act(() => {
          setModels("codex", {
            kind: "ready",
            models: [model("codex", "gpt-mini", "GPT Mini", {})],
          });
        });
        await flushTicks();

        expect(writes()).toEqual([CODEX_GPT_MINI]);
      });
    });

    describe("N4: a switch dropped for having no models, or failing, leaves its sentence behind", () => {
      beforeEach(() => {
        setModels("codex", { kind: "pending" });
      });

      function droppedLine(): HTMLElement | null {
        return screen.queryByTestId("auto-judge-switch-dropped");
      }

      async function switchToCodexThenAfterClose(
        user: UserEvent,
        outcome: "empty" | "error",
      ): Promise<void> {
        judgeRecord.current = { selection: CLAUDE_STORED };
        renderTab();
        await switchToCodexAndClose(user);

        act(() => {
          setModels(
            "codex",
            outcome === "empty"
              ? { kind: "ready", models: [] }
              : { kind: "error" },
          );
        });
        await flushTicks();
      }

      it("failed: the second tile keeps the failed sentence, the store is no longer pending, and the picked status still shows", async () => {
        const user = userEvent.setup();
        await switchToCodexThenAfterClose(user, "error");

        expect(droppedLine()?.textContent).toBe(judgeModelsFailedLine("Codex"));
        expect(screen.queryByTestId("auto-judge-pending-switch")).toBeNull();
        expect(screen.getByTestId("auto-judge-picked-status").textContent).toBe(
          "Billed to your Claude Code account",
        );

        act(() => {
          setModels("codex", {
            kind: "ready",
            models: [model("codex", "gpt-mini", "GPT Mini", {})],
          });
        });
        await flushTicks();
        expect(writes()).toEqual([]);
      });

      it("empty: the second tile keeps the no-models sentence, the store is no longer pending, and the picked status still shows", async () => {
        const user = userEvent.setup();
        await switchToCodexThenAfterClose(user, "empty");

        expect(droppedLine()?.textContent).toBe(judgeNoModelsLine("Codex"));
        expect(screen.queryByTestId("auto-judge-pending-switch")).toBeNull();
        expect(screen.getByTestId("auto-judge-picked-status").textContent).toBe(
          "Billed to your Claude Code account",
        );

        act(() => {
          setModels("codex", {
            kind: "ready",
            models: [model("codex", "gpt-mini", "GPT Mini", {})],
          });
        });
        await flushTicks();
        expect(writes()).toEqual([]);
      });

      it("clears on the next open, and stays gone after closing again", async () => {
        const user = userEvent.setup();
        await switchToCodexThenAfterClose(user, "error");
        expect(droppedLine()).not.toBeNull();

        await user.click(face());
        await screen.findByRole("dialog", { name: "Select model" });
        expect(droppedLine()).toBeNull();

        await closePicker(user);
        expect(droppedLine()).toBeNull();
      });

      it("clears on a tile choice: choosing Automatic drops the line", async () => {
        const user = userEvent.setup();
        await switchToCodexThenAfterClose(user, "error");
        expect(droppedLine()).not.toBeNull();

        await user.click(screen.getByTestId("auto-judge-tile-automatic"));
        expect(droppedLine()).toBeNull();
      });

      it("stays behind when the models fail while the picker is open, after it closes", async () => {
        judgeRecord.current = { selection: CLAUDE_STORED };
        renderTab();
        const user = userEvent.setup();
        await user.click(face());
        await user.click(await screen.findByRole("tab", { name: /Codex/ }));
        expect(screen.getByTestId("auto-judge-pending-switch")).not.toBeNull();

        act(() => {
          setModels("codex", { kind: "error" });
        });
        expect(droppedLine()).toBeNull();

        await closePicker(user);
        await flushTicks();

        expect(droppedLine()?.textContent).toBe(judgeModelsFailedLine("Codex"));
      });

      it("a provider that stops being available while pending leaves no dropped-switch line", async () => {
        judgeRecord.current = { selection: CLAUDE_STORED };
        renderTab();
        const user = userEvent.setup();
        await switchToCodexAndClose(user);

        judgeCatalog.harnesses = [
          harness({
            id: "claude",
            label: "Claude Code",
            nativeAutoJudge: true,
          }),
          harness({
            id: "codex",
            label: "Codex",
            judgeDefaultModel: null,
            available: false,
          }),
        ];
        nudge();
        await flushTicks();

        expect(screen.queryByTestId("auto-judge-pending-switch")).toBeNull();
        expect(droppedLine()).toBeNull();
      });
    });
  });

  describe("a host without Auto mode", () => {
    it("shows the one unsupported line, and no controls", () => {
      support.get = false;
      renderTab();

      expect(screen.getByTestId("auto-mode-unsupported").textContent).toContain(
        "predates Auto mode",
      );
      expect(screen.queryByRole("radio")).toBeNull();
    });

    it("says nothing while support is still unknown", () => {
      support.get = null;
      renderTab();

      expect(screen.queryByTestId("auto-mode-unsupported")).toBeNull();
      expect(screen.queryByRole("radio")).toBeNull();
    });
  });

  it("says so, and inerts both tiles, when the host cannot store a judge", () => {
    support.set = false;
    renderTab();

    expect(
      screen.getByText(/This machine's host can't change the judge/),
    ).not.toBeNull();
    expect(automaticRadio().hasAttribute("disabled")).toBe(true);
    expect(pickRadio().hasAttribute("disabled")).toBe(true);
  });

  describe("harness catalog", () => {
    beforeEach(() => {
      judgeRecord.current = { selection: CLAUDE_STORED };
    });

    it("says so when the catalog query failed", () => {
      judgeCatalog.harnessesStatus = "failed";
      renderTab();

      expect(screen.getByTestId("auto-judge-providers-error").textContent).toBe(
        "Couldn't load this machine's providers. Reopen Settings to try again.",
      );
    });

    it("stays silent while the catalog query is pending", () => {
      judgeCatalog.harnessesStatus = "pending";
      renderTab();

      expect(screen.queryByTestId("auto-judge-providers-error")).toBeNull();
    });

    it("stays silent once the catalog answered", () => {
      renderTab();

      expect(screen.queryByTestId("auto-judge-providers-error")).toBeNull();
    });
  });

  describe("effort footer", () => {
    const SONNET_MODEL = model("claude", "sonnet", "Claude Sonnet", {});
    const EFFORT_MODEL = model("claude", "opus", "Claude Opus", {
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { id: "low", label: "Low", description: null },
        { id: "high", label: "High", description: null },
      ],
    });
    // Grok's live catalog lists Extra High first and defaults to it; the
    // seed must still land on Low, the lowest by canonical rank.
    const REVERSED_MODEL = model("claude", "turbo", "Grok Turbo", {
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: [
        { id: "xhigh", label: "Extra High", description: null },
        { id: "high", label: "High", description: null },
        { id: "medium", label: "Medium", description: null },
        { id: "low", label: "Low", description: null },
      ],
    });
    // No `defaultReasoningEffort`, and catalog order deliberately not
    // low-first, so a fallback to "the model's own default" or to
    // "first in catalog order" would both read differently from "low".
    const MAX_MODEL = model("claude", "opus2", "Claude Opus 2", {
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [
        { id: "medium", label: "Medium", description: null },
        { id: "high", label: "High", description: null },
        { id: "low", label: "Low", description: null },
      ],
    });
    const CODEX_EFFORT_MODEL = model("codex", "turbo-c", "Codex Turbo", {
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { id: "high", label: "High", description: null },
        { id: "low", label: "Low", description: null },
      ],
    });
    // A second provider's model that advertises the SAME level ("high") the
    // judge is stored at on Claude, so a switch that carried the old effort
    // across (rather than resetting it) would read as correct by accident.
    const CODEX_REVERSED_MODEL = model("codex", "xturbo", "Codex X", {
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: [
        { id: "xhigh", label: "Extra High", description: null },
        { id: "high", label: "High", description: null },
        { id: "medium", label: "Medium", description: null },
        { id: "low", label: "Low", description: null },
      ],
    });

    function thinkingEffortGroup(): HTMLElement | null {
      return screen.queryByRole("group", { name: "Thinking effort" });
    }

    function thinkingEffortSlider(): HTMLElement {
      return screen.getByRole("slider", { name: "Thinking effort" });
    }

    // A4 seeds `legacy.effortByHarnessModel` directly; keep it from bleeding
    // into a later test in this file or another.
    afterEach(() => {
      useComposerHarnessMemoryStore.getState().resetForTests();
    });

    it("draws the footer only when autoJudge.set stores an effort; below that line a pick writes reasoningEffort: null", async () => {
      setModels("claude", {
        kind: "ready",
        models: [SONNET_MODEL, EFFORT_MODEL],
      });
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: null,
        },
      };
      autoJudgeSetVersion.current = { major: 1, minor: 3 };
      renderTab();
      const user = userEvent.setup();
      await user.click(face());
      await screen.findByRole("dialog", { name: "Select model" });

      expect(thinkingEffortGroup()).not.toBeNull();
      cleanup();

      setModels("claude", {
        kind: "ready",
        models: [SONNET_MODEL, EFFORT_MODEL],
      });
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: null,
        },
      };
      autoJudgeSetVersion.current = { major: 1, minor: 2 };
      renderTab();
      const user2 = userEvent.setup();
      await user2.click(face());
      await screen.findByRole("dialog", { name: "Select model" });

      expect(thinkingEffortGroup()).toBeNull();

      await user2.click(
        await screen.findByRole("option", { name: /Claude Sonnet/ }),
      );

      expect(writes()).toEqual([
        {
          harnessId: "claude",
          model: "sonnet",
          profileId: null,
          reasoningEffort: null,
        },
      ]);
    });

    it("seeds the footer to the lowest advertised effort, not the model's own default, for an unpicked effort", async () => {
      setModels("claude", { kind: "ready", models: [REVERSED_MODEL] });
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "turbo",
          profileId: null,
          reasoningEffort: null,
        },
      };
      autoJudgeGetVersion.current = { major: 1, minor: 3 };
      autoJudgeSetVersion.current = { major: 1, minor: 3 };
      renderTab();

      expect(face().textContent).toContain("· Low");

      const user = userEvent.setup();
      await user.click(face());
      await screen.findByRole("dialog", { name: "Select model" });

      expect(thinkingEffortSlider().getAttribute("aria-valuetext")).toBe("Low");
    });

    it("shows the stored effort, in the footer and on the face, while the model still advertises it", async () => {
      setModels("claude", { kind: "ready", models: [EFFORT_MODEL] });
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: "high",
        },
      };
      autoJudgeGetVersion.current = { major: 1, minor: 3 };
      autoJudgeSetVersion.current = { major: 1, minor: 3 };
      renderTab();

      expect(face().textContent).toContain("· High");

      const user = userEvent.setup();
      await user.click(face());
      await screen.findByRole("dialog", { name: "Select model" });

      expect(thinkingEffortSlider().getAttribute("aria-valuetext")).toBe(
        "High",
      );
    });

    it("falls back to the lowest advertised effort, in the footer and on the face, when the model no longer advertises the stored one", async () => {
      setModels("claude", { kind: "ready", models: [MAX_MODEL] });
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "opus2",
          profileId: null,
          reasoningEffort: "max",
        },
      };
      autoJudgeGetVersion.current = { major: 1, minor: 3 };
      autoJudgeSetVersion.current = { major: 1, minor: 3 };
      renderTab();

      expect(face().textContent).toContain("· Low");

      const user = userEvent.setup();
      await user.click(face());
      await screen.findByRole("dialog", { name: "Select model" });

      expect(thinkingEffortSlider().getAttribute("aria-valuetext")).toBe("Low");
    });

    it("saves exactly one write, naming the same pick, when the footer is changed on the pick already on show", async () => {
      setModels("claude", { kind: "ready", models: [EFFORT_MODEL] });
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: null,
        },
      };
      autoJudgeSetVersion.current = { major: 1, minor: 3 };
      renderTab();
      const user = userEvent.setup();
      await user.click(face());
      await screen.findByRole("dialog", { name: "Select model" });

      const slider = thinkingEffortSlider();
      expect(slider.getAttribute("aria-valuetext")).toBe("Low");
      fireEvent.keyDown(slider, { key: "ArrowRight" });

      expect(writes()).toEqual([
        {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: "high",
        },
      ]);
    });

    it("writes nothing for a click on the already-checked model row while its footer is untouched, even with a stored effort above the lowest", async () => {
      // A model-row click commits through the composer's funnel with the `""`
      // no-carry lever (the judge store has no memory behind it). A setting
      // store carries the CURRENT effort through that lever, so the re-click
      // keeps High and changes nothing; reading `""` as a reset would write
      // Low here on a click that picked nothing new.
      setModels("claude", { kind: "ready", models: [EFFORT_MODEL] });
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: "high",
        },
      };
      autoJudgeSetVersion.current = { major: 1, minor: 3 };
      renderTab();
      const user = userEvent.setup();
      await user.click(face());
      await user.click(
        await screen.findByRole("option", { name: /Claude Opus/ }),
      );

      expect(thinkingEffortSlider().getAttribute("aria-valuetext")).toBe(
        "High",
      );
      expect(writes()).toEqual([]);
    });

    // R2/R3: a `"setting"` store owns its own effort. A model pick names a
    // DIFFERENT (harness, model) pair than the one on show, so the effort
    // resets to `""` and the "lowest" fallback resolves it against the NEW
    // model's own ladder - never the previous model's stored level, even when
    // the new model happens to advertise that same level too (`opus-next`
    // advertises `high`, same as `opus`, and still lands on Medium, its own
    // lowest).
    it("resets to the new model's lowest advertised effort on every model pick, even one that still advertises the old level", async () => {
      const HIGH_TOO = model("claude", "opus-next", "Claude Opus Next", {
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { id: "medium", label: "Medium", description: null },
          { id: "high", label: "High", description: null },
        ],
      });
      const NO_HIGH = model("claude", "haiku-x", "Claude Haiku X", {
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { id: "medium", label: "Medium", description: null },
          { id: "minimal", label: "Minimal", description: null },
        ],
      });
      setModels("claude", {
        kind: "ready",
        models: [EFFORT_MODEL, HIGH_TOO, NO_HIGH],
      });
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: "high",
        },
      };
      autoJudgeSetVersion.current = { major: 1, minor: 3 };
      renderTab();
      const user = userEvent.setup();
      await user.click(face());
      await user.click(
        await screen.findByRole("option", { name: /Claude Opus Next/ }),
      );
      await user.click(
        await screen.findByRole("option", { name: /Claude Haiku X/ }),
      );

      expect(writes()).toEqual([
        {
          harnessId: "claude",
          model: "opus-next",
          profileId: null,
          reasoningEffort: "medium",
        },
        {
          harnessId: "claude",
          model: "haiku-x",
          profileId: null,
          reasoningEffort: "minimal",
        },
      ]);
    });

    it("writes the new model's lowest advertised effort, not its own default, on a provider switch", async () => {
      picked();
      setModels("codex", { kind: "ready", models: [CODEX_EFFORT_MODEL] });
      autoJudgeSetVersion.current = { major: 1, minor: 3 };
      renderTab();
      const user = userEvent.setup();
      await user.click(face());
      await user.click(await screen.findByRole("tab", { name: /Codex/ }));

      expect(writes()).toEqual([
        {
          harnessId: "codex",
          model: "turbo-c",
          profileId: null,
          reasoningEffort: "low",
        },
      ]);
    });

    it("hides the footer and writes reasoningEffort: null for a model that advertises none", async () => {
      const NO_EFFORT_MODEL = model("claude", "flash", "Claude Flash", {});
      setModels("claude", {
        kind: "ready",
        models: [NO_EFFORT_MODEL, EFFORT_MODEL],
      });
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: "high",
        },
      };
      autoJudgeSetVersion.current = { major: 1, minor: 3 };
      renderTab();
      const user = userEvent.setup();
      await user.click(face());
      await user.click(
        await screen.findByRole("option", { name: /Claude Flash/ }),
      );

      expect(thinkingEffortGroup()).toBeNull();
      expect(writes()).toEqual([
        {
          harnessId: "claude",
          model: "flash",
          profileId: null,
          reasoningEffort: null,
        },
      ]);
    });

    it('names the effort in the "Now:" line when autoJudge.get runs one, and omits it below 1.3', () => {
      judgeCatalog.harnesses = [harness({ id: "traycer", label: "Traycer" })];
      setModels("traycer", {
        kind: "ready",
        models: [
          model("traycer", "haiku", "Claude Haiku", {
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [
              { id: "low", label: "Low", description: null },
              { id: "high", label: "High", description: null },
            ],
          }),
        ],
      });
      judgeRecord.current = {
        selection: null,
        effective: { source: "default", harnessId: "traycer", model: "haiku" },
      };
      autoJudgeGetVersion.current = { major: 1, minor: 3 };
      renderTab();

      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        "Now: Claude Haiku (Low) on Traycer · uses Traycer credits",
      );
      cleanup();

      autoJudgeGetVersion.current = { major: 1, minor: 2 };
      renderTab();

      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        "Now: Claude Haiku on Traycer · uses Traycer credits",
      );
    });

    it("keeps the face silent about effort when autoJudge.get predates it, even though the model advertises one", () => {
      setModels("claude", { kind: "ready", models: [EFFORT_MODEL] });
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: "high",
        },
      };
      autoJudgeGetVersion.current = { major: 1, minor: 2 };
      renderTab();

      expect(face().textContent).not.toContain("· High");
      expect(face().textContent).not.toContain("· Low");
    });

    // R1: the footer is drawn only when the seed IS the pick on show -
    // `judgeSelectionMarked(state)` - not merely because `autoJudge.set`
    // stores an effort. `no-last`, `last-broken` and a `picked` row this
    // build cannot name as a store selection must all hide it: none of them
    // is a pick a footer edit could actually save.
    describe("R1: the footer only draws over the pick on show", () => {
      it("no footer in the no-last row, until a pick lands", async () => {
        // Claude alone, so the picker's browsed rail defaults to it - the
        // seed's unpicked harness - with no ambiguity about which provider's
        // rows the dialog opens onto.
        judgeCatalog.harnesses = [
          harness({
            id: "claude",
            label: "Claude Code",
            nativeAutoJudge: true,
          }),
        ];
        setModels("claude", { kind: "ready", models: [EFFORT_MODEL] });
        noLast();
        autoJudgeSetVersion.current = { major: 1, minor: 3 };
        renderTab();
        const user = userEvent.setup();
        await user.click(pickRadio());
        await screen.findByRole("dialog", { name: "Select model" });

        expect(thinkingEffortGroup()).toBeNull();

        await user.click(
          await screen.findByRole("option", { name: /Claude Opus/ }),
        );

        expect(writes()).toEqual([
          {
            harnessId: "claude",
            model: "opus",
            profileId: null,
            reasoningEffort: "low",
          },
        ]);
        expect(thinkingEffortGroup()).not.toBeNull();
      });

      it("no footer in the last-broken row", async () => {
        setModels("codex", {
          kind: "ready",
          models: [
            model("codex", "gpt-mini", "GPT Mini", {
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                { id: "low", label: "Low", description: null },
                { id: "high", label: "High", description: null },
              ],
            }),
          ],
        });
        lastBroken();
        autoJudgeSetVersion.current = { major: 1, minor: 3 };
        renderTab();

        await userEvent
          .setup()
          .click(screen.getByText(/Always the model you choose/));
        await screen.findByRole("dialog", { name: "Select model" });

        expect(thinkingEffortGroup()).toBeNull();
        expect(writes()).toEqual([]);
      });

      it("no footer for a picked harness this build does not know", async () => {
        // Unrecognized, so the store seeds from the unpicked fallback -
        // Claude alone keeps that fallback off codex (ranked first) and onto
        // the model that actually advertises an effort.
        judgeCatalog.harnesses = [
          harness({
            id: "claude",
            label: "Claude Code",
            nativeAutoJudge: true,
          }),
        ];
        setModels("claude", { kind: "ready", models: [EFFORT_MODEL] });
        judgeRecord.current = {
          selection: {
            harnessId: "mystery",
            model: "m",
            profileId: null,
            reasoningEffort: null,
          },
        };
        autoJudgeSetVersion.current = { major: 1, minor: 3 };
        renderTab();

        await userEvent.setup().click(face());
        await screen.findByRole("dialog", { name: "Select model" });

        expect(thinkingEffortGroup()).toBeNull();
      });
    });

    // R2: a `"setting"` store owns its own effort. The commit funnel's
    // incoming reasoning is honored only by matching it against the
    // COMMITTED pair, never taken at face value: unchanged pair keeps the
    // current effort (composer memory notwithstanding), changed pair resets
    // it through the `""` lever.
    describe("R2/R3: the setting store owns its effort, keyed by the committed pair", () => {
      it("legacy composer memory does not move the judge on a re-click of the checked row", async () => {
        useComposerHarnessMemoryStore.setState({
          legacy: {
            lastProfileByHarness: {},
            lastModelByHarness: {},
            effortByHarnessModel: {
              "claude opus": {
                reasoningEffort: "high",
                serviceTier: null,
                updatedAt: Date.now(),
              },
            },
          },
        });
        setModels("claude", { kind: "ready", models: [EFFORT_MODEL] });
        judgeRecord.current = {
          selection: {
            harnessId: "claude",
            model: "opus",
            profileId: null,
            reasoningEffort: "low",
          },
        };
        autoJudgeSetVersion.current = { major: 1, minor: 3 };
        renderTab();
        const user = userEvent.setup();
        await user.click(face());
        await user.click(
          await screen.findByRole("option", { name: /Claude Opus/ }),
        );

        expect(writes()).toEqual([]);
        expect(thinkingEffortSlider().getAttribute("aria-valuetext")).toBe(
          "Low",
        );
      });

      it("a provider switch from a non-empty effort lands on the new model's lowest, even when the new model still advertises the old level", async () => {
        setModels("claude", { kind: "ready", models: [EFFORT_MODEL] });
        judgeRecord.current = {
          selection: {
            harnessId: "claude",
            model: "opus",
            profileId: null,
            reasoningEffort: "high",
          },
        };
        setModels("codex", { kind: "ready", models: [CODEX_REVERSED_MODEL] });
        autoJudgeSetVersion.current = { major: 1, minor: 3 };
        renderTab();
        const user = userEvent.setup();
        await user.click(face());
        await user.click(await screen.findByRole("tab", { name: /Codex/ }));

        expect(writes()).toEqual([
          {
            harnessId: "codex",
            model: "xturbo",
            profileId: null,
            reasoningEffort: "low",
          },
        ]);
        expect(thinkingEffortSlider().getAttribute("aria-valuetext")).toBe(
          "Low",
        );
      });

      it("a same-provider model change from a non-empty effort lands on the new model's lowest, even when the new model still advertises the old level", async () => {
        setModels("claude", {
          kind: "ready",
          models: [EFFORT_MODEL, MAX_MODEL],
        });
        judgeRecord.current = {
          selection: {
            harnessId: "claude",
            model: "opus",
            profileId: null,
            reasoningEffort: "high",
          },
        };
        autoJudgeSetVersion.current = { major: 1, minor: 3 };
        renderTab();
        const user = userEvent.setup();
        await user.click(face());
        await user.click(
          await screen.findByRole("option", { name: /Claude Opus 2/ }),
        );

        expect(writes()).toEqual([
          {
            harnessId: "claude",
            model: "opus2",
            profileId: null,
            reasoningEffort: "low",
          },
        ]);
      });
    });

    // R4: a same-provider rail re-click keeps the model while its catalog is
    // still loading (`providerSwitchModel`'s hold). With no model row to
    // clamp against, the store emits the stored effort unclamped, and the
    // write guard (`seedRunsEffort`) compares against that same value rather
    // than `null`, so the identical re-commit is not sent.
    it("a same-provider rail click while the catalog is loading writes nothing", async () => {
      setModels("claude", { kind: "ready", models: [EFFORT_MODEL] });
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: "low",
        },
      };
      autoJudgeSetVersion.current = { major: 1, minor: 3 };
      renderTab();
      const user = userEvent.setup();
      await user.click(face());
      await screen.findByRole("dialog", { name: "Select model" });

      act(() => {
        setModels("claude", { kind: "pending" });
      });

      await user.click(await screen.findByRole("tab", { name: /Claude/ }));

      expect(writes()).toEqual([]);
    });
  });
});
