import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import { useBoundSandboxSend } from "@/hooks/sandboxes/use-bound-sandbox-send";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { RestingChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import {
  MESSAGE_CONTENT,
  PICKED_SETTINGS,
  pendingSend,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  pendingSandboxSendFacts,
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import {
  pendingSendState,
  transitionPendingSend,
  UNKNOWN_PENDING_SEND_FACTS,
} from "@/lib/sandboxes/pending-sandbox-send-transition";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";

const catalogue = vi.hoisted(() => ({
  data: undefined as SandboxCatalogue | undefined,
}));

// The cloud catalogue: which agents sandboxes run. It offers the picked agent
// unless a test says otherwise.
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({
    data: [],
    isPending: false,
    fetchStatus: "idle",
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: catalogue.data }),
}));

// The cloud's Traycer list: `undefined` while it is not known.
const traycerList = vi.hoisted(() => ({
  data: undefined as ReadonlyArray<GuiAgentModelOption> | undefined,
}));

vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({ data: traycerList.data }),
}));

const OFFERS_PICK: SandboxCatalogue = {
  providers: [],
  offeredAgents: [PICKED_SETTINGS.harnessId],
};

/**
 * Sending into a chat whose sandbox rests hands the message to the existing
 * pending-send path: the real pending store and the real staged store, with the
 * sandbox's own wake staged under it. Only the catalogue read is answered.
 */

function resting(state: "suspended" | "stopped"): RestingChatSandbox {
  return {
    kind: "resting",
    sandbox: sandboxSummaryFixture({
      id: "sbx-r",
      hostId: "host-r",
      displayName: "e2e-sbx-rest",
      state,
    }),
    configuration: { kind: "team", teamId: "team-a", teamName: "Acme" },
    wakeChangesPayer: true,
  };
}

const INPUT: ChatComposerSubmitInput = {
  content: MESSAGE_CONTENT,
  contentText: "fix the login bug",
  attachments: [],
  settings: PICKED_SETTINGS,
  deliveryPolicy: "auto",
  restartConfirmed: false,
  restore: { content: MESSAGE_CONTENT, browserAnnotations: [] },
};

function pendingSends() {
  return Object.values(usePendingSandboxSendStore.getState().sends);
}

beforeEach(() => {
  catalogue.data = OFFERS_PICK;
  traycerList.data = undefined;
  usePendingSandboxSendStore.setState({ sends: {} });
  useStagedSandboxStore.setState({ bySurface: {} });
});

afterEach(() => {
  useAuthStore.getState().setSignedOut();
  usePendingSandboxSendStore.setState({ sends: {} });
  useStagedSandboxStore.setState({ bySurface: {} });
});

describe("useBoundSandboxSend", () => {
  it.each([
    ["suspended", "resume"],
    ["stopped", "start"],
  ] as const)(
    "records one pending message for the chat and stages the %s sandbox's own %s",
    (state, verb) => {
      const { result } = renderHook(() =>
        useBoundSandboxSend({
          epicId: "epic-1",
          chatId: "chat-1",
          target: resting(state),
        }),
      );

      expect(result.current(INPUT)).toBe(true);

      const [send, ...rest] = pendingSends();
      expect(rest).toEqual([]);
      expect(send).toMatchObject({
        epicId: "epic-1",
        request: { kind: "message", chatId: "chat-1" },
        content: MESSAGE_CONTENT,
        text: "fix the login bug",
        settings: PICKED_SETTINGS,
        epicConfirmed: true,
        delivery: null,
        dispatch: null,
      });
      const stages = Object.values(useStagedSandboxStore.getState().bySurface);
      expect(stages).toHaveLength(1);
      expect(stages[0]?.target).toMatchObject({
        kind: "existing",
        hostId: "host-r",
        sandboxId: "sbx-r",
        name: "e2e-sbx-rest",
        configuration: { kind: "team", teamId: "team-a" },
        verb,
      });
    },
  );

  it("takes a second send of the same stage as no new record and no second wake", () => {
    const { result } = renderHook(() =>
      useBoundSandboxSend({
        epicId: "epic-1",
        chatId: "chat-1",
        target: resting("suspended"),
      }),
    );

    expect(result.current(INPUT)).toBe(true);
    const before = pendingSends().map((send) => send.id);
    const second = result.current(INPUT);

    expect(second).toBe(false);
    expect(pendingSends().map((send) => send.id)).toEqual(before);
    expect(
      Object.keys(useStagedSandboxStore.getState().bySurface),
    ).toHaveLength(1);
  });

  it("refuses an agent sandboxes don't offer before anything is staged, so nothing wakes", () => {
    catalogue.data = { providers: [], offeredAgents: ["traycer"] };
    const { result } = renderHook(() =>
      useBoundSandboxSend({
        epicId: "epic-1",
        chatId: "chat-1",
        target: resting("suspended"),
      }),
    );

    expect(result.current(INPUT)).toBe(false);

    expect(pendingSends()).toEqual([]);
    expect(useStagedSandboxStore.getState().bySurface).toEqual({});
  });

  it("refuses when the catalogue couldn't be read: nothing is recorded or staged, so nothing wakes", () => {
    catalogue.data = undefined;
    const { result } = renderHook(() =>
      useBoundSandboxSend({
        epicId: "epic-1",
        chatId: "chat-1",
        target: resting("suspended"),
      }),
    );

    expect(result.current(INPUT)).toBe(false);

    expect(pendingSends()).toEqual([]);
    expect(useStagedSandboxStore.getState().bySurface).toEqual({});
  });

  it("sends when an older server's catalogue names no agents, and the pending driver runs the wake", () => {
    catalogue.data = { providers: [] };
    const { result } = renderHook(() =>
      useBoundSandboxSend({
        epicId: "epic-1",
        chatId: "chat-1",
        target: resting("suspended"),
      }),
    );

    expect(result.current(INPUT)).toBe(true);

    const [send] = pendingSends();
    const stage =
      useStagedSandboxStore.getState().bySurface[
        pendingSendSurfaceKey(send.id)
      ];
    if (stage === undefined) throw new Error("the send staged no wake");
    expect(stage.target).toMatchObject({ kind: "existing", verb: "resume" });
    const decision = transitionPendingSend(
      pendingSendState(send, "none"),
      "observe",
      pendingSandboxSendFacts(send.id, {
        ...UNKNOWN_PENDING_SEND_FACTS,
        stageStatus: stage.phase,
        wakeInFlight: false,
      }),
    );
    expect(decision.effects).toContain("run-stage");
  });

  describe("a Traycer pick", () => {
    const TRAYCER_INPUT: ChatComposerSubmitInput = {
      ...INPUT,
      settings: { ...PICKED_SETTINGS, harnessId: "traycer", model: "trc-x" },
    };
    const traycerModel = (slug: string): GuiAgentModelOption => ({
      harnessId: "traycer",
      slug,
      label: slug,
      description: null,
      contextWindow: null,
      maxOutputTokens: null,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
      defaultServiceTier: null,
      supportedServiceTiers: [],
      deprecationNotice: null,
      metadata: {},
    });
    const send = () =>
      renderHook(() =>
        useBoundSandboxSend({
          epicId: "epic-1",
          chatId: "chat-1",
          target: resting("suspended"),
        }),
      ).result.current;

    beforeEach(() => {
      catalogue.data = { providers: [], offeredAgents: ["traycer"] };
    });

    it("is refused, with nothing staged, when the cloud's list leaves the model out", () => {
      traycerList.data = [traycerModel("trc-listed")];

      expect(send()(TRAYCER_INPUT)).toBe(false);

      expect(pendingSends()).toEqual([]);
      expect(useStagedSandboxStore.getState().bySurface).toEqual({});
    });

    it("stages the wake when the cloud's list holds the model", () => {
      traycerList.data = [traycerModel("trc-x")];

      expect(send()(TRAYCER_INPUT)).toBe(true);

      expect(pendingSends()).toHaveLength(1);
      expect(
        Object.keys(useStagedSandboxStore.getState().bySurface),
      ).toHaveLength(1);
    });

    it("goes through when no list is known, as the gate does", () => {
      expect(send()(TRAYCER_INPUT)).toBe(true);
    });
  });

  it("sends nothing and stages nothing without a resting target", () => {
    const { result } = renderHook(() =>
      useBoundSandboxSend({ epicId: "epic-1", chatId: "chat-1", target: null }),
    );

    expect(result.current(INPUT)).toBe(false);
    expect(pendingSends()).toEqual([]);
    expect(useStagedSandboxStore.getState().bySurface).toEqual({});
  });

  it("sends for the signed-in account beside another account's undelivered message in the same chat", () => {
    usePendingSandboxSendStore.setState({
      sends: {
        "send-a": pendingSend({
          id: "send-a",
          userId: "user-a",
          epicId: "epic-1",
          request: { kind: "message", chatId: "chat-1", hostId: "host-r" },
        }),
      },
    });
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-b", userName: "B", email: "b@example.com" },
        { userId: "user-b", username: "B" },
        [],
      );
    const { result } = renderHook(() =>
      useBoundSandboxSend({
        epicId: "epic-1",
        chatId: "chat-1",
        target: resting("suspended"),
      }),
    );

    expect(result.current(INPUT)).toBe(true);

    expect(pendingSends().map((send) => send.userId)).toEqual([
      "user-a",
      "user-b",
    ]);
    expect(usePendingSandboxSendStore.getState().sends["send-a"]).toMatchObject(
      { userId: "user-a", delivery: null },
    );
  });
});
