import {
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextSegment } from "@/components/chat/segments/text-segment";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

const KNOWN_AGENT_ID = "be923cf0-e487-4572-b76b-8c70cf6136dd";
const KNOWN_ROLE_CLAIM_ID = "e901561e-f565-461f-8f45-b9bd1c3dd07d";
const FIRST_NEXT_STEP = "Use /implementation-validation to validate the work";
const tileNavigationMocks = vi.hoisted(() => ({
  openTileInEpic: vi.fn(),
}));

vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return {
    ...actual,
    useEpicArtifactRecords: () => [
      {
        id: KNOWN_AGENT_ID,
        parentId: null,
        name: "Planning Agent",
        type: "chat",
        status: null,
        hostId: "host-1",
      },
      {
        id: "abcdef12-1111-4111-8111-111111111111",
        parentId: null,
        name: "First ambiguous agent",
        type: "chat",
        status: null,
        hostId: "host-1",
      },
      {
        id: "abcdef12-2222-4222-8222-222222222222",
        parentId: null,
        name: "Second ambiguous agent",
        type: "chat",
        status: null,
        hostId: "host-1",
      },
    ],
    useEpicChatHarnessId: () => null,
    useMaybeEpicTuiAgentHarnessId: () => null,
  };
});

vi.mock("@/components/ui/tooltip-wrapper", () => ({
  TooltipWrapper: ({ children }: { readonly children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({
    openTileInEpic: tileNavigationMocks.openTileInEpic,
  }),
}));

vi.mock("@/hooks/runner/use-runner-feature-settings-query", () => ({
  useAgentRolesEnabled: () => true,
}));

const COMPLETE_BLOCK = [
  "<TRAYCER_NEXT_STEPS>",
  "Implementation is complete.",
  "",
  "- [] Use /implementation-validation to validate the work",
  "- [ ] Review the changed files with /review-files",
  "</TRAYCER_NEXT_STEPS>",
].join("\n");

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicHandle: OpenEpicStoreHandle;

function render(ui: ReactElement) {
  return testingRender(ui, {
    wrapper: ({ children }) => (
      <EpicSessionContext.Provider value={epicHandle}>
        {children}
      </EpicSessionContext.Provider>
    ),
  });
}

describe("TextSegment next steps rendering", () => {
  let copiedText: string | null = null;

  beforeEach(() => {
    copiedText = null;
    epicHandle = createOpenEpicStore({
      epicId: "epic-1",
      streamClientFactory: noopStreamClientFactory,
      userId: null,
      onAuthError: null,
    });
    epicHandle.store.setState({
      agentRoles: {
        byAgentId: {
          [KNOWN_AGENT_ID]: [
            {
              claimId: KNOWN_ROLE_CLAIM_ID,
              agentId: KNOWN_AGENT_ID,
              userId: "user-1",
              role: "Master of Ceremonies",
              scope: "Celebration",
              claimedAt: 1,
            },
          ],
        },
      },
    });
    tileNavigationMocks.openTileInEpic.mockClear();
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
    epicHandle.dispose();
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

  it("spaces next-steps away from a preceding body that ends in a horizontal rule", () => {
    // Body markdown and next-steps prose are separate `.md-prose` trees. The
    // Tailmark first/last margin zeroing collapses both sides of that boundary,
    // so without an explicit wrapper the next-steps prose sits flush on the
    // trailing `---`.
    render(
      <TextSegment
        findUnitId={null}
        markdown={["Done with the work.", "", "---", "", COMPLETE_BLOCK].join(
          "\n",
        )}
        isStreaming={false}
        nextStepActions={{ canSend: true, onSend: () => true }}
      />,
    );

    const nextSteps = screen.getByTestId("traycer-next-steps");
    const section = nextSteps.parentElement;
    expect(section).not.toBeNull();
    expect(section?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["mt-4", "first:mt-0"]),
    );
    expect(
      section?.contains(screen.getByText("Implementation is complete.")),
    ).toBe(true);
    // Body (with the rule) is a preceding sibling of the next-steps section,
    // not nested inside it.
    expect(section?.contains(screen.getByText("Done with the work."))).toBe(
      false,
    );
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

  it("keeps unsent options enabled after a successful send", () => {
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
    ).toBe(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Review the changed files with /review-files",
      }),
    );

    expect(onSend).toHaveBeenCalledTimes(2);
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

  it("resolves unique UUID prefixes for agents and role claims", () => {
    render(
      <TextSegment
        findUnitId={null}
        markdown={[
          `Agent ${KNOWN_AGENT_ID.slice(0, 8)} accepted the handoff.`,
          `Role claim ${KNOWN_ROLE_CLAIM_ID.slice(0, 8)} owns the ceremony.`,
          `Full claim: \`${KNOWN_ROLE_CLAIM_ID}\`.`,
        ].join("\n\n")}
        isStreaming={false}
        nextStepActions={null}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Planning Agent" })
        .getAttribute("data-agent-reference"),
    ).toBe(KNOWN_AGENT_ID);
    const roleReferences = screen.getAllByRole("button", {
      name: "Master of Ceremonies",
    });
    expect(roleReferences).toHaveLength(2);
    for (const reference of roleReferences) {
      expect(reference.getAttribute("data-agent-reference")).toBe(
        KNOWN_AGENT_ID,
      );
      expect(reference.getAttribute("data-role-claim-reference")).toBe(
        KNOWN_ROLE_CLAIM_ID,
      );
    }
    fireEvent.click(roleReferences[0]);
    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledWith(
      "epic-1",
      expect.objectContaining({
        id: KNOWN_AGENT_ID,
        name: "Planning Agent",
        type: "chat",
        hostId: "host-1",
      }),
    );
    expect(screen.queryByText(KNOWN_ROLE_CLAIM_ID)).toBeNull();
    expect(screen.queryByText(KNOWN_ROLE_CLAIM_ID.slice(0, 8))).toBeNull();
  });

  it("leaves ambiguous UUID prefixes as plain text", () => {
    render(
      <TextSegment
        findUnitId={null}
        markdown="Ambiguous agent abcdef12 stays unresolved."
        isStreaming={false}
        nextStepActions={null}
      />,
    );

    expect(screen.getByText(/abcdef12/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /ambiguous agent/i }),
    ).toBeNull();
  });
});
