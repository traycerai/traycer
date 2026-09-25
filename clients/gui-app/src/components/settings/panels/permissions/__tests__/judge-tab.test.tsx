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
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "autoJudge.get" ? support.get : null,
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    method === "autoJudge.set" ? support.set : false,
  useHostMethodSchemaVersion: () => providersListVersion.current,
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
};
const CODEX_LAST: AutoJudgeSelection = {
  harnessId: "codex",
  model: "gpt-mini",
  profileId: null,
};

beforeEach(() => {
  support.get = true;
  support.set = true;
  providersListVersion.current = { major: 9, minor: 1 };
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
      model("claude", "sonnet", "Claude Sonnet"),
      model("claude", "opus", "Claude Opus"),
    ],
  });
  setModels("codex", {
    kind: "ready",
    models: [model("codex", "gpt-mini", "GPT Mini")],
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
        models: [model("traycer", "haiku", "Claude Haiku")],
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
        { harnessId: "claude", model: "opus", profileId: null },
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
        selection: { harnessId: "codex", model: "gpt-mini", profileId: null },
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
        models: [model("copilot", "gpt-5", "GPT 5")],
      });
      judgeCatalog.providers = [
        ...(judgeCatalog.providers ?? []),
        provider("copilot", [profile("ambient", "ambient")]),
      ];
      judgeRecord.current = {
        selection: { harnessId: "copilot", model: "gpt-5", profileId: null },
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
          models: [model("codex", "gpt-mini", "GPT Mini")],
        });
      });

      await waitFor(() => expect(setJudgeMutate).toHaveBeenCalledTimes(1));
      expect(writes()).toEqual([
        { harnessId: "codex", model: "gpt-mini", profileId: null },
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
        { harnessId: "codex", model: "gpt-mini", profileId: null },
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
    };

    /** Re-renders the tab after the test moved the mocked record or catalog. */
    function nudge(): void {
      act(() => {
        setModels("claude", {
          kind: "ready",
          models: [
            model("claude", "sonnet", "Claude Sonnet"),
            model("claude", "opus", "Claude Opus"),
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
            models: [model("codex", "gpt-mini", "GPT Mini")],
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
            models: [model("codex", "gpt-mini", "GPT Mini")],
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
            models: [model("codex", "gpt-mini", "GPT Mini")],
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
            models: [model("codex", "gpt-mini", "GPT Mini")],
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
          selection: { harnessId: "mystery", model: "m", profileId: null },
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
});
