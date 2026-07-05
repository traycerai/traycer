import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextSegment } from "@/components/chat/segments/text-segment";

const KNOWN_AGENT_ID = "be923cf0-e487-4572-b76b-8c70cf6136dd";
const FIRST_NEXT_STEP = "Use /implementation-validation to validate the work";

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifactRecords: () => [
    {
      id: KNOWN_AGENT_ID,
      parentId: null,
      name: "Planning Agent",
      type: "chat",
      status: null,
      hostId: "host-1",
    },
  ],
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/components/ui/tooltip-wrapper", () => ({
  TooltipWrapper: ({ children }: { readonly children: ReactNode }) => (
    <>{children}</>
  ),
}));

const COMPLETE_BLOCK = [
  "<TRAYCER_NEXT_STEPS>",
  "Implementation is complete.",
  "",
  "- [] Use /implementation-validation to validate the work",
  "- [ ] Review the changed files with /review-files",
  "</TRAYCER_NEXT_STEPS>",
].join("\n");

describe("TextSegment next steps rendering", () => {
  let copiedText: string | null = null;

  beforeEach(() => {
    copiedText = null;
    const clipboard = {
      writeText: vi.fn((value: string) => {
        copiedText = value;
        return Promise.resolve();
      }),
    } satisfies Pick<Clipboard, "writeText">;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: clipboard,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders prose and prompt options as action buttons", () => {
    render(
      <TextSegment
        findUnitId={null}
        markdown={COMPLETE_BLOCK}
        isStreaming={false}
        nextStepActions={{ canSend: true, onSend: () => true }}
      />,
    );

    expect(screen.getByText("Implementation is complete.")).toBeTruthy();
    expect(
      screen
        .getByText("Implementation is complete.")
        .closest(".md-prose")
        ?.classList.contains("prose-base"),
    ).toBe(true);
    expect(
      screen
        .getByText("Implementation is complete.")
        .closest(".md-prose")
        ?.getAttribute("data-quotable"),
    ).toBe("true");
    expect(
      screen.getByRole("button", {
        name: "Use /implementation-validation to validate the work",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Review the changed files with /review-files",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/TRAYCER_NEXT_STEPS/)).toBeNull();
  });

  it("disables action buttons while a next steps block is still streaming", () => {
    render(
      <TextSegment
        findUnitId={null}
        markdown={COMPLETE_BLOCK.replace("\n</TRAYCER_NEXT_STEPS>", "")}
        isStreaming
        nextStepActions={{ canSend: true, onSend: () => true }}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Use /implementation-validation to validate the work",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("locks every option in the block after a successful send", () => {
    const onSend = vi.fn(() => true);
    render(
      <TextSegment
        findUnitId={null}
        markdown={COMPLETE_BLOCK}
        isStreaming={false}
        nextStepActions={{ canSend: true, onSend }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Use /implementation-validation to validate the work",
      }),
    );

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Use /implementation-validation to validate the work",
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Review the changed files with /review-files",
      }).disabled,
    ).toBe(true);
  });

  it("copies a prompt from the trailing next step copy button", () => {
    const onSend = vi.fn(() => true);
    render(
      <TextSegment
        findUnitId={null}
        markdown={COMPLETE_BLOCK}
        isStreaming={false}
        nextStepActions={{ canSend: true, onSend }}
      />,
    );

    const copyButton = screen.getByRole("button", {
      name: `Copy next step: ${FIRST_NEXT_STEP}`,
    });

    expect(copyButton.className).toContain("opacity-0");
    expect(copyButton.className).toContain("group-hover/next-step:opacity-100");
    fireEvent.click(copyButton);

    expect(copiedText).toBe(FIRST_NEXT_STEP);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders blocks without prompt options as normal markdown without raw wrapper tags", () => {
    render(
      <TextSegment
        findUnitId={null}
        markdown={[
          "<TRAYCER_NEXT_STEPS>",
          "Readable prose survives.",
          "",
          "- []",
          "</TRAYCER_NEXT_STEPS>",
        ].join("\n")}
        isStreaming={false}
        nextStepActions={{ canSend: true, onSend: () => true }}
      />,
    );

    expect(screen.getByText("Readable prose survives.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/TRAYCER_NEXT_STEPS/)).toBeNull();
  });

  it("excludes next-step action groups from quote selection", () => {
    render(
      <TextSegment
        findUnitId={null}
        markdown={COMPLETE_BLOCK}
        isStreaming={false}
        nextStepActions={{ canSend: true, onSend: () => true }}
      />,
    );

    expect(
      screen
        .getByTestId("traycer-next-steps")
        .getAttribute("data-quote-exclude"),
    ).toBe("");
  });

  it("does not leak partial wrapper tags while streaming", () => {
    render(
      <TextSegment
        findUnitId={null}
        markdown="<TRAYCER_NEXT_STEPS"
        isStreaming
        nextStepActions={{ canSend: true, onSend: () => true }}
      />,
    );

    expect(screen.queryByText(/TRAYCER_NEXT_STEPS/)).toBeNull();
  });

  it("renders known agent ids as agent reference chips", () => {
    render(
      <TextSegment
        findUnitId={null}
        markdown={[
          `Replied to agent \`${KNOWN_AGENT_ID}\` with the repo orientation.`,
          "",
          `Plain text mention: ${KNOWN_AGENT_ID}.`,
        ].join("\n")}
        isStreaming={false}
        nextStepActions={null}
      />,
    );

    expect(
      screen.getAllByRole("button", { name: "Planning Agent" }),
    ).toBeTruthy();
    expect(screen.queryByText(KNOWN_AGENT_ID)).toBeNull();
  });
});
