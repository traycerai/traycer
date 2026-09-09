import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FallbackGraceCard } from "@/components/chat/fallback/fallback-grace-card";
import { FallbackWaitingCard } from "@/components/chat/fallback/fallback-waiting-card";
import { FallbackWaitResumedMarker } from "@/components/chat/fallback/fallback-notice-attribution";
import { ProviderNoticeSegment } from "@/components/chat/segments/provider-notice-segment";
import { ErrorSegment } from "@/components/chat/segments/error-segment";
import { FALLBACK_SETTINGS_SECTION_ID } from "@/lib/settings-sections";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  pendingFallback,
} from "./fallback-fixtures";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: mocks.mutate,
    isPending: false,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mocks.openSettings }),
}));

const TAB_HOST = "tab-host-b";
const APP_HOST = "app-host-a";

const DETAILS = [
  { label: "via:", value: "Claude Code → Codex" },
  { label: "reason", value: "Rate limit reached" },
];

function assertSettingsLandedOnTabHost(): void {
  // Falsification: delete the carryViewedHostIntoSettingsScope call in open-fallback-settings.ts and THIS assertion must go red.
  expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(TAB_HOST);
  expect(useSettingsHostScopeStore.getState().scopedHostId).not.toBe(APP_HOST);
  expect(mocks.openSettings).toHaveBeenCalledWith({
    section: FALLBACK_SETTINGS_SECTION_ID,
    resetToGeneral: false,
  });
}

describe("fallback settings links carry the tab host", () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.openSettings.mockReset();
    useSettingsHostScopeStore.getState().setScopedHostId(APP_HOST);
  });

  afterEach(() => {
    cleanup();
    useSettingsHostScopeStore.getState().setScopedHostId(null);
  });

  it("opens Fallback settings on the tab host from the grace card", () => {
    render(
      <TabHostProvider hostId={TAB_HOST}>
        <FallbackGraceCard
          pending={pendingFallback({
            state: "hold",
            reason: "rate_limit",
            failedTuple: FAILED_CLAUDE_TUPLE,
            targetTuple: TARGET_CODEX_TUPLE,
            impendingAction: null,
            deadline: Date.now() + 12_000,
            attempt: 1,
            maxAttempts: 3,
            queuedItemsMoving: 0,
            siblingSwitching: 0,
            traversalId: "traversal-settings",
            revision: 1,
          })}
          client={null}
          chatId="chat-settings"
          epicId="epic-settings"
          hostId={TAB_HOST}
          canAct
          menu={null}
        />
      </TabHostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fallback settings" }));
    assertSettingsLandedOnTabHost();
  });

  it("opens Fallback settings on the tab host from the waiting card", () => {
    render(
      <TabHostProvider hostId={TAB_HOST}>
        <FallbackWaitingCard
          pending={pendingFallback({
            state: "waiting",
            reason: "rate_limit",
            failedTuple: FAILED_CLAUDE_TUPLE,
            targetTuple: null,
            impendingAction: null,
            deadline: Date.now() + 60_000,
            attempt: 1,
            maxAttempts: 1,
            queuedItemsMoving: 0,
            siblingSwitching: 0,
            traversalId: "traversal-settings",
            revision: 1,
          })}
          client={null}
          chatId="chat-settings"
          epicId="epic-settings"
          hostId={TAB_HOST}
          canAct
          menu={null}
        />
      </TabHostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fallback settings" }));
    assertSettingsLandedOnTabHost();
  });

  it("opens Fallback settings on the tab host from an expanded fallback_applied notice", () => {
    render(
      <TabHostProvider hostId={TAB_HOST}>
        <ProviderNoticeSegment
          status="completed"
          noticeKind="fallback_applied"
          tone="info"
          title="Switched providers"
          message="Moved to Codex."
          details={DETAILS}
          findUnitId={null}
        />
      </TabHostProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button", { name: "Fallback settings" }));
    assertSettingsLandedOnTabHost();
  });

  it("opens Fallback settings on the tab host from the resumed-turn marker", () => {
    render(
      <TabHostProvider hostId={TAB_HOST}>
        <FallbackWaitResumedMarker
          title="Resumed after waiting"
          message="The limit reset."
          details={DETAILS}
          findUnitId={null}
        />
      </TabHostProvider>,
    );
    fireEvent.click(screen.getByText("Resumed after waiting"));
    fireEvent.click(screen.getByRole("button", { name: "Fallback settings" }));
    assertSettingsLandedOnTabHost();
  });

  it("opens Fallback settings on the tab host from an auth error row", () => {
    render(
      <TooltipProvider>
        <TabHostProvider hostId={TAB_HOST}>
          <ErrorSegment
            turnId={null}
            message="Signed out of Claude Code."
            code="auth"
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={{ reason: "auth" }}
          />
        </TabHostProvider>
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fallback settings" }));
    assertSettingsLandedOnTabHost();
  });
});
