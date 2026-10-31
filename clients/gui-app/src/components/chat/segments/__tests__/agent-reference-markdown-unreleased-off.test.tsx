/**
 * The build without bots (`unreleased-features.ts`) through the REAL markdown
 * path (`AgentReferenceMarkdown` over `TraycerMarkdown`): `<@id>` with an
 * agent's id is the agent's chip between the literal `<@` and `>`, as the
 * release before drew it, and never a mention. With the features on, the same
 * token is a mention. The rehype plugin list is read once at import, so each
 * case imports the renderer fresh under its own switch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

const AGENT_ID = "11111111-2222-3333-4444-555555555555";

const features = vi.hoisted(() => ({ enabled: false }));

vi.mock("@/unreleased-features", () => ({
  get UNRELEASED_FEATURES_ENABLED() {
    return features.enabled;
  },
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

vi.mock("@/components/ui/tooltip-wrapper", () => ({
  TooltipWrapper: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifactRecords: () => [
    { id: AGENT_ID, type: "chat", name: "Planner" },
  ],
  useEpicAgentRoleClaimsByAgentId: () => ({}),
  useOpenEpicId: () => "epic-1",
  useEpicChatHarnessId: () => null,
  useMaybeEpicTuiAgentHarnessId: () => null,
}));

afterEach(() => {
  cleanup();
  vi.resetModules();
});

/**
 * Renders `markdown` in an open epic whose agent is {@link AGENT_ID}, inside a
 * mention provider that names the same id as a member - so a mention element,
 * if one is made, shows as the member's chip.
 */
async function renderUnder(
  enabled: boolean,
  markdown: string,
): Promise<HTMLElement> {
  features.enabled = enabled;
  const { AgentReferenceMarkdown } =
    await import("@/components/chat/segments/agent-reference-markdown");
  const { EpicSessionContext, handleHostIds } =
    await import("@/lib/registries/epic-session-registry");
  const { BotMentionsContext } =
    await import("@/components/bots/bot-mentions-context");
  const handle = {} as OpenEpicStoreHandle;
  handleHostIds.set(handle, "host-1");
  const { container } = render(
    <EpicSessionContext value={handle}>
      <BotMentionsContext
        value={(userId) =>
          userId === AGENT_ID ? { name: "Pat", self: false } : null
        }
      >
        <AgentReferenceMarkdown
          isStreaming={false}
          markdown={markdown}
          proseSize="compact"
          quotable={false}
          components={null}
        />
      </BotMentionsContext>
    </EpicSessionContext>,
  );
  return container;
}

describe("an agent id inside <@…>", () => {
  it("is the agent's chip without the features, and no mention", async () => {
    const container = await renderUnder(false, `ask <@${AGENT_ID}> next`);

    expect(screen.getByRole("button").textContent).toBe("Planner");
    expect(screen.queryByTestId("bot-mention")).toBeNull();
    expect(container.textContent).toBe("ask <@Planner> next");
  });

  it("is a mention with the features", async () => {
    await renderUnder(true, `ask <@${AGENT_ID}> next`);

    expect(screen.getByTestId("bot-mention").textContent).toBe("@Pat");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
