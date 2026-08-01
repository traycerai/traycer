import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { encodeBase64 } from "@traycer-clients/shared/cloud-chat/bytes";
import {
  DEFAULT_PUBLISH,
  FIRST_COHORT,
  IDENTITY,
  assistantMessage,
  publishCloudChat,
  textBlock,
  userMessage,
  type PublishedCloudChat,
} from "@traycer-clients/shared/cloud-chat/__tests__/__fixtures__/published-cloud-chat";
import { SECOND_COHORT } from "@traycer-clients/shared/cloud-chat/__tests__/__fixtures__/published-cloud-chat";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { CloudChatDialog } from "@/components/epic-canvas/sidebar/cloud-chat-dialog";

/**
 * The reopen property, asserted where it actually has to hold.
 *
 * The driver suite proves "after one new turn, fetch the head and the tail
 * shard" against the read pipeline directly. That is necessary and it is not
 * sufficient: the GUI can satisfy every one of those assertions one layer down
 * and still never re-enter the pipeline, because a cached TanStack query with
 * `staleTime: Infinity` answers a reopen out of memory. This suite mounts the
 * real dialog over a counting transport and asserts the counts ACROSS an
 * open → publish → reopen cycle.
 *
 * Both halves are checked deliberately. The counts say the read happened; the
 * rendered text says the NEW publication is what the user is looking at. Either
 * alone can pass while the other is wrong - a refetch whose result is discarded
 * counts, and a re-render of cached data reads correctly.
 */

// ---- The counting transport --------------------------------------------- //

type RequestLog = {
  readonly resolves: string[];
  readonly parts: string[];
};

const log: RequestLog = { resolves: [], parts: [] };
let served: PublishedCloudChat | null = null;
/** Refs the payload LIST reports as fetchable. */
let fetchableRefs: readonly { kind: string; sha256: string }[] = [];
/** When set, `epic.readCloudChatPayload` fails with it. */
let payloadFailure: HostRpcError | null = null;

/**
 * Typed `unknown` and shaped by hand, following this package's existing
 * host-client doubles: `HostClient` is a class with far more surface than any
 * of these paths touch, and the repo forbids casting through `unknown` to
 * pretend otherwise.
 */
const hostClient: unknown = {
  getActiveHostId: () => "host-1",
  getRequestContextUserId: () => "u-1",
  onChange: () => () => undefined,
  request: (method: string, params: { readonly sha256?: string }) => {
    const chat = served;
    if (chat === null) throw new Error("No publication is being served");
    if (method === "epic.resolveCloudChatHead") {
      log.resolves.push(chat.headSha256);
      return Promise.resolve({
        chat: chat.summary,
        outcome: {
          status: "ok",
          head: chat.headDocument,
          headSha256: chat.headSha256,
        },
      });
    }
    if (method === "epic.readCloudChatPart") {
      const sha256 = params.sha256 ?? "";
      log.parts.push(sha256);
      const bytes = chat.bytesByDigest.get(sha256);
      if (bytes === undefined) {
        return Promise.resolve({ outcome: { status: "not-found" } });
      }
      return Promise.resolve({
        outcome: {
          status: "ok",
          bytesBase64: encodeBase64(bytes),
          byteLength: bytes.byteLength,
        },
      });
    }
    if (method === "epic.readCloudChatPayload") {
      if (payloadFailure !== null) return Promise.reject(payloadFailure);
      return Promise.resolve({ outcome: { status: "unavailable" } });
    }
    throw new Error(`Unexpected method ${method}`);
  },
  // The payload list rides `useHostQuery`, which uses the signal-taking form.
  requestWithSignal: (method: string) => {
    if (method === "epic.listCloudChatPayloads") {
      return Promise.resolve({
        outcome: { status: "ok", refs: [...fetchableRefs] },
      });
    }
    throw new Error(`Unexpected streamed method ${method}`);
  },
};

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => hostClient,
}));

vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ contextMetadata: { userId: "u-1" } }),
}));

// ---- Fixtures ------------------------------------------------------------ //

const SUMMARY: CloudChatSummary = {
  identity: IDENTITY,
  ownerHostId: "host-origin",
  createdAt: 1,
  visibility: "task",
  title: "A published chat",
  isTitleEditedByUser: false,
  parentChatId: null,
  isArchived: false,
  runSettingsSummary: null,
  metadataUpdatedAt: 5,
  headSha256: null,
  publishedAt: 1,
  throughRecordSeq: 42,
  isOwnedByViewer: true,
};

/** The fixture chat with one more turn appended to its TAIL cohort. */
function publishOneMoreTurn(): Promise<PublishedCloudChat> {
  return publishCloudChat({
    ...DEFAULT_PUBLISH,
    cohorts: [
      FIRST_COHORT,
      [
        ...SECOND_COHORT,
        userMessage("m-user-3"),
        assistantMessage("m-assistant-3", [
          textBlock("b-text-3", "the newest turn"),
        ]),
      ],
    ],
  });
}

/**
 * ## What this suite deliberately does NOT claim
 *
 * The reopen fix turns on observer lifecycle, so the obvious next question is
 * whether StrictMode's double mount perturbs it. It cannot be answered here: a
 * probe in this package measured one mount effect with `<StrictMode>` and one
 * without, so wrapping a test in it would assert nothing while looking like it
 * asserted something. That class is verified in the dev app, not in jsdom.
 */
function renderDialog(open: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <CloudChatDialog
      identity={IDENTITY}
      summary={SUMMARY}
      open={open}
      onOpenChange={() => undefined}
    />,
    {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
}

beforeEach(() => {
  log.resolves.length = 0;
  log.parts.length = 0;
  served = null;
  fetchableRefs = [];
  payloadFailure = null;
});

afterEach(() => {
  cleanup();
});

describe("reopening a cloud chat", () => {
  it("re-resolves the head and fetches ONLY the shard that moved", async () => {
    const first = await publishCloudChat(DEFAULT_PUBLISH);
    served = first;

    const view = renderDialog(true);
    await screen.findByText("here is the change");

    expect(log.resolves).toHaveLength(1);
    expect(log.parts).toEqual(
      first.parts.map((part) => part.address.sha256),
    );

    // Close. The dialog's content unmounts with it.
    view.rerender(
      <CloudChatDialog
        identity={IDENTITY}
        summary={SUMMARY}
        open={false}
        onOpenChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText("here is the change")).toBeNull();
    });

    // The owning device publishes one more turn while the dialog is closed.
    const second = await publishOneMoreTurn();
    served = second;
    log.parts.length = 0;

    view.rerender(
      <CloudChatDialog
        identity={IDENTITY}
        summary={SUMMARY}
        open
        onOpenChange={() => undefined}
      />,
    );

    // The user sees the NEW turn - which is only possible if the head was read
    // again. Without that, TanStack answers the reopen from cache and this line
    // never appears.
    await screen.findByText("the newest turn");

    // One head read per open lifecycle, and exactly one part: the tail cohort.
    // Everything else came out of the content-addressed cache the first open
    // filled, which is the whole incremental-read property.
    expect(log.resolves).toHaveLength(2);
    expect(log.parts).toEqual([second.parts[1].address.sha256]);
    expect(second.parts[0].address.sha256).toBe(
      first.parts[0].address.sha256,
    );
  });

  it("does NOT re-read while the dialog stays open", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    served = published;

    const view = renderDialog(true);
    await screen.findByText("here is the change");
    expect(log.resolves).toHaveLength(1);

    // A parent re-render is not a reopen. Swapping the transcript under a
    // reader mid-scroll would be worse than showing the copy they opened.
    view.rerender(
      <CloudChatDialog
        identity={IDENTITY}
        summary={SUMMARY}
        open
        onOpenChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("here is the change")).not.toBeNull();
    });

    expect(log.resolves).toHaveLength(1);
  });
});

describe("a payload the cloud will not serve", () => {
  it("degrades to the unavailable marker instead of spinning forever", async () => {
    served = await publishCloudChat(DEFAULT_PUBLISH);
    // The fixture's `file_change` block names this digest, and the list says it
    // is fetchable - so the transcript offers a control rather than a marker.
    fetchableRefs = [{ kind: "file-snapshot", sha256: "aaa111" }];
    // The shape the reviewer named: a host that simply lacks the payload
    // method. It is answered on the first attempt and never retried.
    payloadFailure = new HostRpcError({
      code: "E_HOST_UNSUPPORTED",
      message: "no such method",
      requestId: "r",
      method: "epic.readCloudChatPayload",
      fatalDetails: null,
    });

    renderDialog(true);
    const control = await screen.findByRole("button", {
      name: "File contents (before)",
    });

    fireEvent.click(control);

    // The row settles. Before this, a failed query left `data` undefined and
    // the row fell through to its spinner - forever, since the retries were
    // already spent.
    await waitFor(() => {
      expect(
        screen.getByText("File contents (before) is not available here."),
      ).not.toBeNull();
    });
  });
});

