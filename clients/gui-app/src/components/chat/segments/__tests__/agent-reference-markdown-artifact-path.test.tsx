/**
 * A bare artifact path in agent-reference markdown through the REAL render
 * path (`AgentReferenceMarkdown` over `TraycerMarkdown`): guards the reported
 * regression where a path like
 * `.../epics/<id>/artifacts/.../screenshots/index.html` rendered as a UUID
 * task chip for the embedded epic id, surrounded by the rest of the path as
 * raw text, instead of one artifact chip for the whole path. The hast-level
 * reproduction of that bug lives in
 * `markdown/plugins/__tests__/rehype-traycer-artifact-references.test.ts`;
 * this exercises the same markdown through the full wired-up component.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentReferenceMarkdown } from "@/components/chat/segments/agent-reference-markdown";
import {
  MarkdownLinkContext,
  type MarkdownLinkPolicy,
} from "@/markdown/links/markdown-link-context";

afterEach(cleanup);

const EPIC_ID = "4f14b1e2-9c3a-4b7d-8e21-7a2c5d6f9b10";
const ARTIFACT_PATH = `/Users/tgill/.traycer/epics/${EPIC_ID}/artifacts/md-objects-t2-degraded-strip/screenshots/index.html`;

function stubPolicy(
  openFileLink: MarkdownLinkPolicy["openFileLink"],
): MarkdownLinkPolicy {
  return { openFileLink, supersedePendingFileLink: () => undefined };
}

function renderWithPolicy(markdown: string, policy: MarkdownLinkPolicy) {
  return render(
    <MarkdownLinkContext.Provider value={policy}>
      <AgentReferenceMarkdown
        isStreaming={false}
        markdown={markdown}
        proseSize="compact"
        quotable={false}
        components={null}
      />
    </MarkdownLinkContext.Provider>,
  );
}

describe("a bare artifact path in agent-reference markdown", () => {
  it("renders exactly one chip labeled by the containing folder, and opens the untouched full path on click", () => {
    const openFileLink = vi
      .fn<MarkdownLinkPolicy["openFileLink"]>()
      .mockReturnValue(true);
    renderWithPolicy(`See ${ARTIFACT_PATH}.`, stubPolicy(openFileLink));

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("data-traycer-ref")).toBe("artifact");
    expect(buttons[0].textContent).toBe("screenshots");

    fireEvent.click(buttons[0]);

    expect(openFileLink).toHaveBeenCalledWith({
      path: ARTIFACT_PATH,
      line: null,
      col: null,
      isDirectory: false,
    });
  });
});
