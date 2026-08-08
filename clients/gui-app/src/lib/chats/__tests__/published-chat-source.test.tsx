import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PublishedChatSourceProvider,
  usePublishedPlanContent,
  usePublishedSnapshotDiff,
} from "@/lib/chats/published-chat-source";

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
 */

const readPayload = vi.fn();
/** What the mocked reader answers; `undefined` models a query still in flight. */
const payloadAnswer: { current: { readonly kind: string } | undefined } = {
  current: undefined,
};

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatPayload: (args: {
    readonly enabled: boolean;
    readonly ref: { readonly kind: string; readonly sha256: string } | null;
  }) => {
    // Records only what a real query would ACT on. A disabled TanStack query
    // issues nothing, so counting mounts would prove nothing either way.
    if (args.enabled) readPayload(args.ref);
    return { data: payloadAnswer.current, isError: false };
  },
}));

afterEach(() => {
  cleanup();
  readPayload.mockClear();
  payloadAnswer.current = undefined;
});

const IDENTITY = {
  taskId: "d60781ca",
  chatId: "56254cae",
  ownerUserId: "user-1",
};

function Diff(props: { readonly published: boolean }): ReactNode {
  // Mirrors the segment: both hooks mount, exactly one is enabled.
  const source = props.published ? { identity: IDENTITY, client: null } : null;
  usePublishedSnapshotDiff({
    source,
    beforeHash: "a".repeat(64),
    afterHash: "b".repeat(64),
    enabled: source !== null,
  });
  return <div data-testid="diff" />;
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
    render(
      <PublishedChatSourceProvider
        source={{ identity: IDENTITY, client: null }}
      >
        <Diff published={true} />
      </PublishedChatSourceProvider>,
    );
    const kinds = readPayload.mock.calls.map((call) => call[0]?.kind);
    expect(kinds).toEqual(["file-snapshot", "file-snapshot"]);
  });

  it("reads the plan-content payload for a published copy", () => {
    render(
      <PublishedChatSourceProvider
        source={{ identity: IDENTITY, client: null }}
      >
        <Plan published={true} />
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
    let seen: string | null = null;
    function Probe(): ReactNode {
      const result = usePublishedSnapshotDiff({
        source: { identity: IDENTITY, client: null },
        beforeHash: "a".repeat(64),
        afterHash: null,
        enabled: true,
      });
      seen = result.data?.reason ?? null;
      return null;
    }
    render(<Probe />);
    expect(seen).toBe("blob_missing");
  });
});
