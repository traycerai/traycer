import "../../../../../__tests__/test-browser-apis";

import type { ComponentType, ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `TraycerMarkdown` keys its parse `useMemo` - and `MarkdownBlock` its memo
 * comparator - on the `components` object's IDENTITY. Capturing that identity
 * across renders is the observable for "does an unrelated rerender reparse every
 * markdown block on the surface".
 */
const captured = vi.hoisted(() => {
  const seen: unknown[] = [];
  return seen;
});
vi.mock("@/markdown", () => ({
  TraycerMarkdown: (props: {
    readonly components: unknown;
    readonly children: ReactNode;
  }) => {
    captured.push(props.components);
    return <div data-testid="markdown">{props.children}</div>;
  },
}));

import { AgentReferenceMarkdown } from "@/components/chat/segments/agent-reference-markdown";

const OVERRIDE: Record<string, ComponentType<Record<string, unknown>>> = {
  a: () => <span />,
};

beforeEach(() => {
  captured.length = 0;
});

afterEach(cleanup);

function renderBody(
  components: Record<string, ComponentType<Record<string, unknown>>> | null,
) {
  return (
    <AgentReferenceMarkdown
      isStreaming={false}
      markdown="hello"
      proseSize="compact"
      quotable={false}
      components={components}
    />
  );
}

describe("AgentReferenceMarkdown component merging", () => {
  it("keeps one components identity across rerenders with the same override", () => {
    const view = render(renderBody(OVERRIDE));
    view.rerender(renderBody(OVERRIDE));
    view.rerender(renderBody(OVERRIDE));

    expect(captured.length).toBeGreaterThan(1);
    // A fresh merge per render would invalidate the parse cache of every block
    // on the surface, on every unrelated rerender.
    expect(captured.every((entry) => entry === captured[0])).toBe(true);
  });

  it("still merges the override over the shared set", () => {
    render(renderBody(OVERRIDE));

    const merged = captured[0] as Record<string, unknown>;
    expect(merged.a).toBe(OVERRIDE.a);
    // ...without dropping what the shared renderer contributes.
    expect(merged.code).toBeDefined();
  });

  it("hands chat surfaces the shared constant untouched", () => {
    const view = render(renderBody(null));
    view.rerender(renderBody(null));

    expect(captured[0]).toBe(captured[1]);
    expect((captured[0] as Record<string, unknown>).a).toBeUndefined();
  });

  it("produces a new identity only when the override itself changes", () => {
    const other: Record<string, ComponentType<Record<string, unknown>>> = {
      a: () => <b />,
    };
    const view = render(renderBody(OVERRIDE));
    view.rerender(renderBody(other));

    expect(captured[captured.length - 1]).not.toBe(captured[0]);
  });
});
