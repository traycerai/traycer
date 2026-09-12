import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AutoJudgeUnattendedDenialSegment } from "@/components/chat/segments/auto-judge-unattended-denial-segment";

afterEach(() => {
  cleanup();
});

describe("<AutoJudgeUnattendedDenialSegment />", () => {
  it("renders the head sentence alone when rule and reason are both null", () => {
    render(<AutoJudgeUnattendedDenialSegment rule={null} reason={null} />);

    expect(
      screen.getByText(
        "Refused without asking. This chat was running for another agent, so there was nobody to ask.",
      ),
    ).toBeTruthy();
  });

  it("renders the rule and reason suffixed with an em dash when both are present", () => {
    render(
      <AutoJudgeUnattendedDenialSegment
        rule="Force push"
        reason="This rewrites remote history."
      />,
    );

    expect(
      screen.getByText(
        "Refused without asking. This chat was running for another agent, so there was nobody to ask. Force push — This rewrites remote history.",
      ),
    ).toBeTruthy();
  });

  it("carries the note role and the find-include marker for chat find", () => {
    render(<AutoJudgeUnattendedDenialSegment rule={null} reason={null} />);

    const note = screen.getByTestId("auto-judge-unattended-denial");
    expect(note.getAttribute("role")).toBe("note");
    expect(note.querySelector('[data-find-include="true"]')).not.toBeNull();
  });
});
