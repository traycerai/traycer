import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { FileChangeSegment as FileChangeSegmentModel } from "@/stores/composer/chat-store";
import { FileChangeSegment } from "@/components/chat/segments/file-change-segment";
import { ThemeProvider } from "@/providers/theme-provider";
import {
  payloadTruncationNotice,
  usePublishedPlanContent,
  usePublishedSnapshotDiff,
} from "@/lib/chats/published-chat-source";
import { PublishedChatSourceProvider } from "@/lib/chats/published-chat-source-provider";

/**
 * The seam's load-bearing property, pinned the deliberately-green way.
 *
 * The claim worth testing is NOT "a live chat still renders" - that would pass
 * whether or not the cloud path leaked into it. It is the stronger, negative
 * one: on a live surface the cloud payload reader is **never consulted**. So
 * the reader is a spy, and the live assertions are about the calls it did not
 * receive.
 *
 * Without that, a seam that quietly enabled itself everywhere would look
 * healthy in every test here while doubling every live chat's requests and
 * addressing them at a chat the reading host has no publication for.
 *
 * The live assertion drives the REAL segment (`FileChangeSegment`), not a local
 * stand-in for it. A harness that re-implements the dispatch can only prove the
 * harness dispatches correctly; the property belongs to the component that
 * ships, and mounting it with no provider is what pins that the null default
 * reaches production code.
 */

/** The content address a payload read is issued against. */
interface PayloadRef {
  readonly kind: string;
  readonly sha256: string;
}

/**
 * Typed rather than a bare `vi.fn()`: the assertions below read `.kind` off
 * recorded calls, and an untyped spy makes every one of those an `any` hop.
 */
const readPayload = vi.fn<(ref: PayloadRef | null) => void>();
/** What the mocked reader answers; `undefined` models a query still in flight. */
const payloadAnswer: {
  current:
    | {
        readonly kind: string;
        readonly text?: string;
        readonly isTruncated?: boolean;
        readonly byteLength?: number;
      }
    | undefined;
} = { current: undefined };

/**
 * The hashes whose reads FAILED - a query that exhausted its retries, not a
 * payload that answered "unavailable". The two are the same `data: undefined`
 * to a naive reader, which is exactly the confusion under test, so the mock
 * keeps them as separate controls rather than one "no content" switch.
 */
const failedHashes = new Set<string>();
/** Which side a retry re-issued, so "only the failed one" is checkable. */
const refetched = vi.fn<(sha256: string) => void>();

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatPayload: (args: {
    readonly enabled: boolean;
    readonly ref: PayloadRef | null;
  }) => {
    // Records only what a real query would ACT on. A disabled TanStack query
    // issues nothing, so counting mounts would prove nothing either way.
    if (args.enabled) readPayload(args.ref);
    const sha256 = args.ref?.sha256 ?? "";
    const refetch = (): Promise<void> => {
      refetched(sha256);
      return Promise.resolve();
    };
    if (args.enabled && failedHashes.has(sha256)) {
      return { data: undefined, isError: true, refetch };
    }
    if (payloadAnswer.current === undefined) {
      return { data: undefined, isError: false, refetch };
    }
    // Distinct text per side, so a real unified patch can be built and the
    // segment reaches its diff branch rather than its reason copy.
    const side = args.ref?.sha256.startsWith("a") === true ? "old\n" : "new\n";
    return {
      data: { ...payloadAnswer.current, text: side },
      isError: false,
      refetch,
    };
  },
}));

/**
 * The LIVE data source, stubbed - not the thing under test here.
 *
 * Mounting the real segment on the live path otherwise needs the whole host
 * runtime, which is itself the point: the live arm depends on the host and the
 * published arm does not. Stubbing it keeps the REAL dispatcher in the test
 * while removing a dependency the assertion does not concern.
 */
vi.mock("@/hooks/snapshots/use-snapshot-diff-query", () => ({
  useSnapshotDiffQuery: () => ({ data: undefined, isLoading: false }),
}));

afterEach(() => {
  cleanup();
  readPayload.mockClear();
  refetched.mockClear();
  failedHashes.clear();
  payloadAnswer.current = undefined;
});

const BEFORE_HASH = "a".repeat(64);
const AFTER_HASH = "b".repeat(64);
const PLAN_HASH = "c".repeat(64);

const IDENTITY = {
  taskId: "d60781ca",
  chatId: "56254cae",
  ownerUserId: "user-1",
};

/** A real `file_change` segment, expanded so its diff body mounts. */
const FILE_SEGMENT = {
  id: "file-1",
  kind: "file_change",
  filePath: "/repo/src/app.ts",
  operation: "edit",
  diffSource: "snapshot",
  beforeHash: "a".repeat(64),
  afterHash: "b".repeat(64),
  additions: 1,
  deletions: 1,
  sourceBlockIds: ["file-1"],
  reason: "snapshot",
  isStreaming: false,
  endState: null,
  parentId: null,
} satisfies FileChangeSegmentModel;

function Diff(props: { readonly published: boolean }): ReactNode {
  // The real diff body reads the resolved theme, so the real provider comes
  // with it. Wrapping is cheaper than mocking the diff primitive, which is the
  // very component whose banner slot carries the notice under test.
  const segment = (
    <ThemeProvider>
      <FileChangeSegment
        segment={FILE_SEGMENT}
        variant="card"
        headerFindUnitId={null}
        initiallyOpen
      />
    </ThemeProvider>
  );
  if (!props.published) return segment;
  return (
    <PublishedChatSourceProvider source={{ identity: IDENTITY, client: null }}>
      {segment}
    </PublishedChatSourceProvider>
  );
}

function Plan(props: { readonly published: boolean }): ReactNode {
  const source = props.published ? { identity: IDENTITY, client: null } : null;
  usePublishedPlanContent({
    source,
    contentHash: "c".repeat(64),
    enabled: source !== null,
  });
  return <div data-testid="plan" />;
}

describe("published chat source", () => {
  it("never consults the cloud payload reader on a live surface", () => {
    // The constraint. No provider is mounted, so the source is null and the
    // live path must be byte-identical to what shipped before the seam.
    render(<Diff published={false} />);
    render(<Plan published={false} />);
    expect(readPayload).not.toHaveBeenCalled();
  });

  it("reads file-snapshot payloads for a published copy", () => {
    render(<Diff published />);
    const kinds = readPayload.mock.calls.map((call) => call[0]?.kind);
    expect(kinds).toEqual(["file-snapshot", "file-snapshot"]);
  });

  it("reads the plan-content payload for a published copy", () => {
    render(
      <PublishedChatSourceProvider
        source={{ identity: IDENTITY, client: null }}
      >
        <Plan published />
      </PublishedChatSourceProvider>,
    );
    expect(readPayload).toHaveBeenCalledTimes(1);
    expect(readPayload.mock.calls[0][0]?.kind).toBe("plan-content");
  });

  it("reports a hash the cloud cannot serve as a missing blob", () => {
    // The same fact the local store reports when a blob is gone, so the segment
    // draws the banner it already has instead of a new vocabulary.
    // A SETTLED unavailable answer, not an in-flight one - the distinction the
    // hook itself draws, and the reason the loading arm exists.
    payloadAnswer.current = { kind: "unavailable" };

    const { result } = renderHook(() =>
      usePublishedSnapshotDiff({
        source: { identity: IDENTITY, client: null },
        beforeHash: "a".repeat(64),
        afterHash: null,
        enabled: true,
      }),
    );

    expect(result.current.data?.reason).toBe("blob_missing");
    // The other half of the distinction: an answered refusal is NOT a failure,
    // so nothing offers to retry a blob the owner never uploaded.
    expect(result.current.failure).toBeNull();
  });

  it("reports a truncated payload as a prefix, with its real byte length", () => {
    // The reviewer's witness: a 65,547-byte payload served as a 65,536-byte
    // prefix. Dropping `isTruncated` made the surface present the prefix as the
    // whole file - worse than the viewer this ticket demolished, which said so.
    payloadAnswer.current = {
      kind: "text",
      text: "x",
      isTruncated: true,
      byteLength: 65_547,
    };
    const { result } = renderHook(() =>
      usePublishedSnapshotDiff({
        source: { identity: IDENTITY, client: null },
        beforeHash: "a".repeat(64),
        afterHash: "b".repeat(64),
        enabled: true,
      }),
    );

    expect(result.current.truncation).toEqual({
      isTruncated: true,
      byteLength: 65_547,
    });
  });

  it("carries truncation on a published plan too", () => {
    payloadAnswer.current = {
      kind: "text",
      text: "x",
      isTruncated: true,
      byteLength: 65_547,
    };
    const { result } = renderHook(() =>
      usePublishedPlanContent({
        source: { identity: IDENTITY, client: null },
        contentHash: "c".repeat(64),
        enabled: true,
      }),
    );

    const truncation = result.current.truncation;
    expect(truncation).not.toBeNull();
    expect(
      truncation === null ? null : payloadTruncationNotice(truncation),
    ).toBe("Showing the first part of 65547 bytes.");
  });

  it("reports no truncation for a complete payload", () => {
    // The other half: a whole payload must not acquire a partial-content
    // marker, or every diff would claim to be a prefix.
    payloadAnswer.current = {
      kind: "text",
      text: "x",
      isTruncated: false,
      byteLength: 12,
    };
    const { result } = renderHook(() =>
      usePublishedSnapshotDiff({
        source: { identity: IDENTITY, client: null },
        beforeHash: "a".repeat(64),
        afterHash: null,
        enabled: true,
      }),
    );

    expect(result.current.truncation).toBeNull();
  });

  it("renders the truncation notice on the real segment, not just in the hook", () => {
    // The ablation that caught this: dropping `truncation` at the segment left
    // every hook assertion green while the surface silently presented a prefix
    // as a whole file. The finding was about what RENDERS, so this asserts the
    // rendered marker.
    payloadAnswer.current = {
      kind: "text",
      text: "x",
      isTruncated: true,
      byteLength: 65_547,
    };
    render(<Diff published />);
    const notice = screen.getByTestId("file-change-truncated-notice");
    expect(notice.textContent).toContain("65547");
  });

  it("renders no truncation notice for a complete payload", () => {
    payloadAnswer.current = {
      kind: "text",
      text: "x",
      isTruncated: false,
      byteLength: 12,
    };
    render(<Diff published />);
    expect(screen.queryByTestId("file-change-truncated-notice")).toBeNull();
  });

  it("reports an exhausted read as a failure, not as a missing blob", () => {
    // The defect: an errored query's `data` is `undefined`, `payloadText` reads
    // that as `null`, and the diff reported `blob_missing` - a permanent
    // verdict about the owner's upload for a fault that is one request away
    // from clearing.
    failedHashes.add(BEFORE_HASH);

    const { result } = renderHook(() =>
      usePublishedSnapshotDiff({
        source: { identity: IDENTITY, client: null },
        beforeHash: BEFORE_HASH,
        afterHash: null,
        enabled: true,
      }),
    );

    expect(result.current.failure).not.toBeNull();
    // A diff cannot be rendered from a side that never answered, so no verdict
    // is offered at all - `blob_missing` least of all.
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("fails the whole diff when only ONE side errored", () => {
    // Both halves are required, so a served "before" against an unreachable
    // "after" is not a partial diff - it is no diff.
    payloadAnswer.current = { kind: "text", text: "x", isTruncated: false };
    failedHashes.add(AFTER_HASH);

    const { result } = renderHook(() =>
      usePublishedSnapshotDiff({
        source: { identity: IDENTITY, client: null },
        beforeHash: BEFORE_HASH,
        afterHash: AFTER_HASH,
        enabled: true,
      }),
    );

    expect(result.current.failure).not.toBeNull();
    expect(result.current.data).toBeUndefined();
  });

  it("retries only the side that failed", () => {
    // A payload is content-addressed: the side that answered holds bytes that
    // cannot become different bytes, so re-requesting it is a wasted round trip.
    payloadAnswer.current = { kind: "text", text: "x", isTruncated: false };
    failedHashes.add(AFTER_HASH);

    const { result } = renderHook(() =>
      usePublishedSnapshotDiff({
        source: { identity: IDENTITY, client: null },
        beforeHash: BEFORE_HASH,
        afterHash: AFTER_HASH,
        enabled: true,
      }),
    );
    result.current.failure?.retry();

    expect(refetched.mock.calls.map((call) => call[0])).toEqual([AFTER_HASH]);
  });

  it("keeps a pending read loading rather than calling it a failure", () => {
    // The loading arm must still win while a side is genuinely in flight, or
    // every published diff would flash a retry before its first answer.
    const { result } = renderHook(() =>
      usePublishedSnapshotDiff({
        source: { identity: IDENTITY, client: null },
        beforeHash: BEFORE_HASH,
        afterHash: AFTER_HASH,
        enabled: true,
      }),
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.failure).toBeNull();
  });

  it("reports an exhausted plan read as a failure, not as absent content", () => {
    failedHashes.add(PLAN_HASH);

    const { result } = renderHook(() =>
      usePublishedPlanContent({
        source: { identity: IDENTITY, client: null },
        contentHash: PLAN_HASH,
        enabled: true,
      }),
    );

    expect(result.current.failure).not.toBeNull();
    expect(result.current.markdown).toBeNull();
    expect(result.current.isLoading).toBe(false);

    result.current.failure?.retry();
    expect(refetched.mock.calls.map((call) => call[0])).toEqual([PLAN_HASH]);
  });

  it("reports a served plan payload as content, with no failure", () => {
    payloadAnswer.current = { kind: "text", text: "x", isTruncated: false };

    const { result } = renderHook(() =>
      usePublishedPlanContent({
        source: { identity: IDENTITY, client: null },
        contentHash: PLAN_HASH,
        enabled: true,
      }),
    );

    expect(result.current.failure).toBeNull();
    expect(result.current.markdown).not.toBeNull();
  });

  it("offers a working retry on the real segment, in place of the reason copy", () => {
    // The rendered half of the finding: the hook can distinguish the two facts
    // and the surface still print "blob missing" over it. This drives the REAL
    // segment, and the click asserts the mechanism - the retry reaches the
    // reader - rather than that a handler prop was passed.
    payloadAnswer.current = { kind: "text", text: "x", isTruncated: false };
    failedHashes.add(BEFORE_HASH);

    render(<Diff published />);

    expect(screen.queryByText("Skipped - snapshot blob missing.")).toBeNull();
    fireEvent.click(screen.getByTestId("file-change-diff-retry"));
    expect(refetched.mock.calls.map((call) => call[0])).toEqual([BEFORE_HASH]);
  });

  it("offers no retry on the real segment when the blob is simply absent", () => {
    payloadAnswer.current = { kind: "unavailable" };

    render(<Diff published />);

    expect(screen.queryByTestId("file-change-diff-retry")).toBeNull();
    expect(screen.getByText("Skipped - snapshot blob missing.")).toBeTruthy();
  });
});
