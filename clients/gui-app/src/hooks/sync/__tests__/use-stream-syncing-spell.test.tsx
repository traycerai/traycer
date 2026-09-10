import "../../../../__tests__/test-browser-apis";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { useStreamSyncingSpell } from "@/hooks/sync/use-stream-syncing-spell";
import { LINK_DOWN_ESCALATION_MS } from "@/lib/link-down-escalation";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

interface SpellInput {
  readonly status: StreamConnectionStatus;
  readonly hasContent: boolean;
  readonly identity: string;
}

function renderSpell(initial: SpellInput) {
  return renderHook((input: SpellInput) => useStreamSyncingSpell(input), {
    initialProps: initial,
  });
}

describe("useStreamSyncingSpell", () => {
  // The gate as a matrix rather than as a handful of examples: the contract is
  // "a surface with content on screen whose own stream is away", and every
  // other combination has to stay silent - including the two that look like
  // they should speak (a cold connect, a dead stream).
  const STATUSES: readonly StreamConnectionStatus[] = [
    "connecting",
    "open",
    "reconnecting",
    "closed",
  ];
  const SYNCING: ReadonlySet<StreamConnectionStatus> = new Set([
    "connecting",
    "reconnecting",
  ]);

  for (const status of STATUSES) {
    for (const hasContent of [true, false]) {
      const expected = hasContent && SYNCING.has(status);
      it(`syncing=${String(expected)} for status=${status} hasContent=${String(hasContent)}`, () => {
        const { result } = renderSpell({ status, hasContent, identity: "a" });
        expect(result.current.syncing).toBe(expected);
        expect(result.current.escalated).toBe(false);
      });
    }
  }

  it("escalates once the resync stops looking momentary", () => {
    vi.useFakeTimers();
    const { result } = renderSpell({
      status: "reconnecting",
      hasContent: true,
      identity: "a",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS - 1);
    });
    expect(result.current.escalated).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.escalated).toBe(true);
  });

  it("treats connecting and reconnecting as ONE outage, not two", () => {
    // A clock keyed on the raw status restarts on this flip and so never
    // escalates on a link that flaps between the two.
    vi.useFakeTimers();
    const { result, rerender } = renderSpell({
      status: "connecting",
      hasContent: true,
      identity: "a",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS / 2);
    });
    rerender({ status: "reconnecting", hasContent: true, identity: "a" });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS / 2);
    });
    expect(result.current.escalated).toBe(true);
  });

  it("clears the escalated verdict the moment the stream is back", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderSpell({
      status: "reconnecting",
      hasContent: true,
      identity: "a",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
    });
    expect(result.current.escalated).toBe(true);

    rerender({ status: "open", hasContent: true, identity: "a" });
    expect(result.current.syncing).toBe(false);
    expect(result.current.escalated).toBe(false);

    // A genuinely NEW outage starts unescalated rather than inheriting the
    // previous one's verdict.
    rerender({ status: "reconnecting", hasContent: true, identity: "a" });
    expect(result.current.escalated).toBe(false);
  });

  it("keeps timing an outage across a window in which nothing is drawn", () => {
    // The suppression case, at the level that decides it. The phone hides a
    // chat's strip while the Epic's is speaking, and the Epic's stream usually
    // returns first. If the clock lived in the hidden strip it would restart at
    // that hand-off, so a chat down since t=0 would say "Syncing…" - and start
    // animating again - a minute into its own outage. The hook is called
    // throughout, so what the caller drew is not part of the question.
    vi.useFakeTimers();
    const { result } = renderSpell({
      status: "reconnecting",
      hasContent: true,
      identity: "chat-1",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
    });
    expect(result.current.syncing).toBe(true);
    expect(result.current.escalated).toBe(true);
  });

  it("starts a new spell when the subject changes, escalated or not", () => {
    // Swipe from a chat whose resync has already escalated to one that has just
    // dropped. Without the identity the second chat inherits "Still syncing…"
    // and a stopped animation about an outage seconds old - the component is
    // reused, so no `key` on the strip would catch it either.
    vi.useFakeTimers();
    const { result, rerender } = renderSpell({
      status: "reconnecting",
      hasContent: true,
      identity: "chat-1",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
    });
    expect(result.current.escalated).toBe(true);

    rerender({ status: "reconnecting", hasContent: true, identity: "chat-2" });
    expect(result.current.syncing).toBe(true);
    expect(result.current.escalated).toBe(false);

    // And the NEW subject's clock runs its own full interval rather than
    // finishing the one it interrupted.
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS - 1);
    });
    expect(result.current.escalated).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.escalated).toBe(true);
  });

  it("does not escalate a subject whose stream recovered before the interval", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderSpell({
      status: "reconnecting",
      hasContent: true,
      identity: "a",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS / 2);
    });
    rerender({ status: "open", hasContent: true, identity: "a" });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
    });
    expect(result.current.escalated).toBe(false);
  });
});
