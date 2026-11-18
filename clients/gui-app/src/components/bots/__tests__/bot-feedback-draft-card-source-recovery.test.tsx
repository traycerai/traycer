import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  ChatFeedbackDraftDecideRequest,
  ChatFeedbackDraftPreviewRequest,
} from "@traycer/protocol/host/chat/feedback-draft";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";

/**
 * T356. The card's source host can drop out of the directory, or lose its
 * connection, while the channel stays open, and come back without the card
 * being remounted. The client resolution here is the REAL one
 * (`useHostClientForHostId` over `resolveNamedHostClient`, which hands back a
 * requester pinned to the host id even when the directory has no row for it:
 * that requester is not null, its requests fail at the preflight). Faked are
 * only the two boundaries beneath it: the app binding's spine, and the
 * directory row, which `findHostById` and the entry hook both read.
 */

interface World {
  /** The source host's directory row, or null while the directory has none. */
  entry: HostDirectoryEntry | null;
  spine: HostClient<HostRpcRegistry> | null;
  /** How the host answers the next decide. */
  decideMode: "transport-fails" | "session-unavailable" | "settles" | "pending";
}

const world = vi.hoisted((): World => ({
  entry: null,
  spine: null,
  decideMode: "settles",
}));

vi.mock("@/lib/host/runtime", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/host/runtime")>()),
  useHostBinding: () =>
    world.spine === null
      ? null
      : { hostClient: world.spine, hostId: undefined },
  useHostClient: () => world.spine,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => world.entry,
}));

import { BotFeedbackDraftCard } from "@/components/bots/bot-feedback-draft-card";
import {
  PENDING,
  SOURCE,
  UNAVAILABLE_COPY,
} from "./bot-feedback-draft-card-test-support";

const PENDING_WITH_DIAGNOSTICS: ToolCallFeedbackDraftStamp = {
  ...PENDING,
  suggestDiagnostics: true,
};

const REMEMBERED_MANIFEST = {
  "host.status": { major: 1, minor: 0 },
  "chat.feedbackDraft.decide": { major: 1, minor: 0 },
  "chat.feedbackDraft.preview": { major: 1, minor: 0 },
} as const;

const requests: {
  decide: ChatFeedbackDraftDecideRequest[];
  preview: ChatFeedbackDraftPreviewRequest[];
} = { decide: [], preview: [] };
let requestCounter = 0;

function buildSpine(): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `request-${String(++requestCounter)}`,
      handlers: {
        "chat.feedbackDraft.decide": (params) => {
          requests.decide.push(params);
          switch (world.decideMode) {
            case "transport-fails":
              throw new HostTransportFailureError({
                code: "RPC_ERROR",
                message: "connection lost",
                requestId: "lost",
                method: "chat.feedbackDraft.decide",
                fatalDetails: null,
              });
            case "session-unavailable":
              return {
                kind: "error",
                code: "session-unavailable",
                feedbackDraft: null,
              };
            case "pending":
              return new Promise(() => undefined);
            case "settles":
              return {
                kind: "settled",
                feedbackDraft: {
                  ...PENDING_WITH_DIAGNOSTICS,
                  state: params.decision === "send" ? "sent" : "skipped",
                  decidedAt: 5,
                },
              };
          }
        },
        "chat.feedbackDraft.preview": (params) => {
          requests.preview.push(params);
          return {
            kind: "preview",
            details: [],
            logTail: "",
            logTailTruncated: false,
          };
        },
      },
    }),
    findHostById: (hostId) =>
      world.entry !== null && hostId === world.entry.hostId
        ? world.entry
        : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine;
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}

/** One query client per mount, so a re-render is the same mount. */
function renderCard(): {
  readonly rerender: (draft: ToolCallFeedbackDraftStamp) => void;
} {
  const queryClient = new QueryClient();
  // A fresh element each time: React skips an identical one.
  const tree = (draft: ToolCallFeedbackDraftStamp) => (
    <QueryClientProvider client={queryClient}>
      <BotFeedbackDraftCard source={{ ...SOURCE }} draft={{ ...draft }} />
    </QueryClientProvider>
  );
  const view = render(tree(PENDING_WITH_DIAGNOSTICS));
  return { rerender: (draft) => view.rerender(tree(draft)) };
}

function actionsOffered(): boolean {
  const send = screen.queryByRole("button", { name: "Send" });
  const skip = screen.queryByRole("button", { name: "Skip" });
  return (
    send !== null &&
    !send.hasAttribute("disabled") &&
    skip !== null &&
    !skip.hasAttribute("disabled") &&
    screen.queryByRole("button", { name: "View" }) !== null
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  resetNegotiatedManifests();
  requestCounter = 0;
  requests.decide.length = 0;
  requests.preview.length = 0;
  world.entry = mockLocalHostEntry;
  world.decideMode = "settles";
  world.spine = buildSpine();
  // The host's last handshake, remembered, has the methods.
  recordNegotiatedHostManifest(SOURCE.hostId, REMEMBERED_MANIFEST);
});
afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  vi.useRealTimers();
});

describe("<BotFeedbackDraftCard /> when its source host leaves and returns", () => {
  it("offers no action and no diagnostics View while the directory has no row for the source, and offers them again when the row returns in the same mount", async () => {
    world.entry = null;
    const view = renderCard();
    await settle();

    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
    expect(screen.getByText(UNAVAILABLE_COPY)).toBeTruthy();
    expect(requests.decide).toHaveLength(0);
    expect(requests.preview).toHaveLength(0);

    world.entry = { ...mockLocalHostEntry, version: "0.0.1-mock" };
    view.rerender(PENDING_WITH_DIAGNOSTICS);
    await settle();

    expect(actionsOffered()).toBe(true);
    expect(screen.queryByText(UNAVAILABLE_COPY)).toBeNull();
    expect(requests.decide).toHaveLength(0);
  });

  it.each([
    ["a transport failure", "transport-fails"],
    ["a session-unavailable answer", "session-unavailable"],
  ] as const)(
    "after %s, offers only an explicit retry of the original decision once the source returns in the same mount, and sends nothing until it is pressed",
    async (_label, failure) => {
      world.decideMode = failure;
      const view = renderCard();

      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await settle();

      expect(requests.decide).toHaveLength(1);
      const first = requests.decide[0];
      expect(first).toMatchObject({
        decision: "send",
        includeDiagnostics: true,
      });
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

      // The source drops out of the directory: nothing to retry against.
      world.entry = null;
      view.rerender(PENDING_WITH_DIAGNOSTICS);
      await settle();
      expect(screen.queryByRole("button", { name: "Retry Send" })).toBeNull();
      expect(screen.getByText(UNAVAILABLE_COPY)).toBeTruthy();

      // The source reconnects: a new incarnation of the same host.
      world.decideMode = "settles";
      world.entry = { ...mockLocalHostEntry, version: "0.0.1-mock" };
      view.rerender(PENDING_WITH_DIAGNOSTICS);
      await settle();

      // Only the original intent: offering the other would change the decision
      // the uncertain first attempt may already have made.
      expect(
        screen
          .getByRole("button", { name: "Retry Send" })
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(screen.queryByRole("button", { name: "Retry Skip" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
      expect(screen.queryByRole("button", { name: "View" })).toBeNull();
      expect(requests.decide).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Retry Send" }));
      await settle();

      // The captured request, whole: same decision, same diagnostics choice,
      // same click identity.
      expect(requests.decide).toHaveLength(2);
      expect(requests.decide[1]).toEqual(first);
      expect(screen.getByText("Sent")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry Send" })).toBeNull();
    },
  );

  /** The first attempt fails in transport, then the source returns. */
  async function failThenReturn(clickName: "Send" | "Skip"): Promise<{
    readonly rerender: (draft: ToolCallFeedbackDraftStamp) => void;
  }> {
    world.decideMode = "transport-fails";
    const view = renderCard();
    fireEvent.click(screen.getByRole("button", { name: clickName }));
    await settle();
    world.decideMode = "settles";
    world.entry = { ...mockLocalHostEntry, version: "0.0.1-mock" };
    view.rerender(PENDING_WITH_DIAGNOSTICS);
    await settle();
    return view;
  }

  it("offers only Retry Skip after a failed Skip, and retries that Skip with its original identity and no diagnostics", async () => {
    await failThenReturn("Skip");

    expect(
      screen
        .getByRole("button", { name: "Retry Skip" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry Send" })).toBeNull();
    expect(requests.decide).toHaveLength(1);
    const first = requests.decide[0];
    expect(first).toMatchObject({
      decision: "skip",
      includeDiagnostics: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry Skip" }));
    await settle();

    expect(requests.decide).toHaveLength(2);
    expect(requests.decide[1]).toEqual(first);
    expect(screen.getByText("Skipped")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry Skip" })).toBeNull();
  });

  it("offers no retry once the projection the channel holds is terminal", async () => {
    const view = await failThenReturn("Send");
    expect(screen.getByRole("button", { name: "Retry Send" })).toBeTruthy();

    view.rerender({ ...PENDING_WITH_DIAGNOSTICS, state: "sent", decidedAt: 5 });
    await settle();

    expect(screen.queryByRole("button", { name: "Retry Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry Skip" })).toBeNull();
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(requests.decide).toHaveLength(1);
  });

  it("disables the retry while it is in flight and sends it once", async () => {
    await failThenReturn("Send");
    world.decideMode = "pending";

    fireEvent.click(screen.getByRole("button", { name: "Retry Send" }));
    await settle();

    expect(requests.decide).toHaveLength(2);
    expect(
      screen
        .getByRole("button", { name: "Retry Send" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry Send" }));
    await settle();
    expect(requests.decide).toHaveLength(2);
  });
});
