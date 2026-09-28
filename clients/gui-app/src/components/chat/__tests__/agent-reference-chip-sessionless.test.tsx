import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AgentReferenceChip } from "@/components/chat/agent-reference-chip";
import { TextSegment } from "@/components/chat/segments/text-segment";

/**
 * With no `<EpicSessionContext>` above it (the layout editor's sample
 * workspace, or markdown rendered before an epic session mounts),
 * `EpicSessionGate` routes to the fallback branch and `ResolvedAgentReferenceChip`
 * never mounts - so none of its selectors (`@/lib/epic-selectors`) or
 * `useOpenEpicHandle` ever run. Nothing here is mocked, on purpose: this is
 * the regression the real hooks used to fail on
 * ("useOpenEpicHandle must be called inside <EpicSessionProvider>.").
 */
afterEach(cleanup);

describe("AgentReferenceChip with no open epic session", () => {
  it("renders the id as plain text instead of throwing", () => {
    render(<AgentReferenceChip agentId="c303ea21b" display="text" />);

    expect(screen.getByText("c303ea21b")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the id as code instead of throwing", () => {
    render(<AgentReferenceChip agentId="c303ea21b" display="code" />);

    const code = screen.getByText("c303ea21b");
    expect(code.tagName).toBe("CODE");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("agent references in rendered markdown with no open epic session", () => {
  it("shows a reference-shaped token as plain text instead of throwing", () => {
    // Driven through the real chat transcript path (TextSegment ->
    // AgentReferenceMarkdown -> rehypeTraycerAgentReferences), not a mocked
    // markdown renderer. "c303ea21" is 8 hex chars, the shortest shape
    // `isUuidReferenceCandidate` accepts, so the plugin actually chips it
    // rather than leaving it as untouched prose.
    const { container } = render(
      <TextSegment
        findUnitId={null}
        markdown="Fixed in commit c303ea21."
        isStreaming={false}
        nextStepActions={null}
      />,
    );

    expect(container.textContent).toContain("c303ea21");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
