import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  LOCAL_VOICE,
  createSynth,
  installSpeech,
} from "@/components/chat/__tests__/fake-speech-synthesis";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { EpicTreeRecord } from "@/lib/epic-selectors";
import {
  EpicSessionContext,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { MessageSegment } from "@/stores/composer/chat-store";

const AGENT_ID = "3f2b9c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const ROLE_CLAIM_ID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

const epic = vi.hoisted(() => ({
  records: [] as ReadonlyArray<EpicTreeRecord>,
  roleClaimsByAgentId: {} as Readonly<Record<string, readonly RoleClaim[]>>,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: () => undefined }),
}));

vi.mock("@/hooks/epic/use-epic-agent-open-ref", () => ({
  useEpicAgentOpenRef: () => () => ({
    id: AGENT_ID,
    instanceId: "inst-1",
    type: "chat",
  }),
}));

vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicArtifactRecords: () => epic.records,
  useEpicAgentRoleClaimsByAgentId: () => epic.roleClaimsByAgentId,
  useOpenEpicId: () => "epic-1",
  useEpicChatHarnessId: () => null,
  useMaybeEpicTuiAgentHarnessId: () => null,
}));

import { AssistantMessageBody } from "@/components/chat/chat-message-assistant-body";

beforeEach(() => {
  epic.records = [
    {
      id: AGENT_ID,
      parentId: null,
      name: "Planner",
      type: "chat",
      status: null,
      hostId: "host-1",
    },
  ];
  epic.roleClaimsByAgentId = {
    [AGENT_ID]: [
      {
        claimId: ROLE_CLAIM_ID,
        agentId: AGENT_ID,
        userId: "user-1",
        role: "reviewer",
        scope: "the read-aloud change",
        claimedAt: 1_700_000_000_000,
      },
    ],
  };
  installSpeech(createSynth([LOCAL_VOICE]));
});

afterEach(() => {
  cleanup();
  installSpeech(null);
});

/**
 * `EpicSessionGate` only checks for a non-null handle; the mocked selectors
 * above are what read the epic, so the chips and the boundary row's
 * resolution both see the same agent and role claim.
 */
function handle(): OpenEpicStoreHandle {
  const value = {} as OpenEpicStoreHandle;
  handleHostIds.set(value, "host-1");
  return value;
}

function textSegment(markdown: string): MessageSegment {
  return { id: "reply-seg", kind: "text", markdown, isStreaming: false };
}

function Reply(props: {
  readonly markdown: string;
  readonly boundary: boolean;
}): ReactNode {
  return (
    <AssistantMessageBody
      turnId={null}
      segments={props.boundary ? [] : [textSegment(props.markdown)]}
      backgroundToolBlockIds={new Set<string>()}
      runState={null}
      messageId="assistant:a"
      elapsedStartedAt={0}
      turnHasOnlyAutonomousResumeSegments={false}
      autonomousResumeOwed={false}
      showCompletionFooter
      pausedDurationMs={0}
      pausedSinceMs={null}
      completedAt={5_000}
      stopped={
        props.boundary
          ? {
              stoppedAt: 1_700_000_000_000,
              reason: "Stop requested by owner.",
              turnHadOutput: true,
              turnReplySegments: [textSegment(props.markdown)],
            }
          : null
      }
      meta={null}
      manualRungAnchorId={null}
      nextStepActions={null}
      forkAction={null}
      interviewDeliveryRetry={null}
      routingSettledNoticeId={null}
    />
  );
}

function spokenAfterPlay(markdown: string, boundary: boolean): string {
  const synth = createSynth([LOCAL_VOICE]);
  installSpeech(synth);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider delayDuration={0}>
        <ChatExpansionTestProviders tileInstanceId="read-aloud-test-tile">
          <EpicSessionContext value={handle()}>
            <Reply markdown={markdown} boundary={boundary} />
          </EpicSessionContext>
        </ChatExpansionTestProviders>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTestId("assistant-reply-read-aloud"));
  act(() => synth.finishAll());
  return synth.spoken.map((utterance) => utterance.text).join(" ");
}

describe.each([
  ["a row that draws its reply", false],
  ["the stopped-boundary row", true],
] as const)("reply read-aloud on %s", (_where, boundary) => {
  it("reads an agent reference as the chip shows it: the agent's name", () => {
    expect(spokenAfterPlay(`Ask ${AGENT_ID} for the plan.`, boundary)).toBe(
      "Ask Planner for the plan.",
    );
  });

  it("reads a role reference in inline code as the chip shows it: the role", () => {
    expect(
      spokenAfterPlay(`Send it to \`${ROLE_CLAIM_ID}\` next.`, boundary),
    ).toBe("Send it to reviewer next.");
  });

  it("reads an id-shaped token that names no agent as written", () => {
    expect(
      spokenAfterPlay("Fixed in commit c303ea21 and `d404fb32`.", boundary),
    ).toBe("Fixed in commit c303ea21 and d404fb32.");
  });
});
