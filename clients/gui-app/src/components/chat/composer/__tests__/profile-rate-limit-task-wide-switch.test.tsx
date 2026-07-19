import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ProfileDropdownUsageEntry } from "@/components/providers/profile-dropdown-usage";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { ProfileRateLimitSwitchBanner } from "../profile-rate-limit-switch-banner";
import type { ProfileRateLimitDestination } from "../use-profile-rate-limit-switch-prompt";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { commitProfileSelection } from "@/stores/composer/commit-selection";
import { TooltipProvider } from "@/components/ui/tooltip";

const usage = vi.hoisted(() => ({
  entries: new Map() as Map<string | null, ProfileDropdownUsageEntry>,
}));

vi.mock("@/hooks/rate-limits/use-profile-usage-presentation", () => ({
  useProfileUsagePresentation: () => ({
    isHostReady: true,
    entries: usage.entries,
  }),
}));

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
  rateLimitStatus: "ok" | "hard_limit",
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus,
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

const CURRENT = profile(
  "limited-uuid",
  "managed",
  "Limited profile",
  "hard_limit",
);
const ALTERNATIVE = profile("fresh-uuid", "managed", "Fresh profile", "ok");
const SECOND = profile("second-uuid", "managed", "Second profile", "ok");
const AMBIENT = profile("ambient", "ambient", "Terminal account", "ok");
const BLOCKED = profile(
  "blocked-uuid",
  "managed",
  "Blocked profile",
  "hard_limit",
);

function destination(
  candidate: ProviderProfile,
  selectable: boolean,
): ProfileRateLimitDestination {
  return {
    profile: candidate,
    profileId: profileCommitId(candidate),
    selectable,
  };
}

function usageEntry(
  profileId: string | null,
  refresh: () => Promise<void>,
): ProfileDropdownUsageEntry {
  const now = Date.now();
  const window = {
    id: "primary",
    role: "primary" as const,
    name: null,
    severity: "running_low" as const,
    window: {
      usedPercent: 42,
      resetsAt: now + 60 * 60 * 1_000,
      durationMinutes: 300,
    },
  };
  return {
    profileId,
    refreshStatus: "idle",
    refresh,
    projection: {
      kind: "detail",
      severity: "running_low",
      checkedAt: now,
      unavailableReason: null,
      compactWindow: window,
      windows: [window],
    },
  };
}

function renderBanner(input: {
  readonly affectedChatCount: number;
  readonly destinations: ReadonlyArray<ProfileRateLimitDestination> | undefined;
  readonly primaryTarget: ProfileRateLimitDestination | null | undefined;
  readonly profiles: ReadonlyArray<ProviderProfile> | undefined;
  readonly onSwitchProfile: (profileId: string | null) => void;
  readonly onSwitchProfileForTask: (profileId: string | null) => void;
}) {
  const destinations = input.destinations ?? [destination(ALTERNATIVE, true)];
  const profiles = input.profiles ?? [CURRENT, ALTERNATIVE];
  const primaryTarget =
    input.primaryTarget === undefined
      ? (destinations.find((entry) => entry.selectable) ?? null)
      : input.primaryTarget;
  return render(
    <TooltipProvider delayDuration={0}>
      <ProfileRateLimitSwitchBanner
        harnessId="claude"
        providerId="claude-code"
        severity="hard_limit"
        limitedFamilies={[]}
        current={CURRENT}
        profiles={profiles}
        destinations={destinations}
        primaryTarget={primaryTarget}
        runTargetHostId={null}
        onSwitchProfile={input.onSwitchProfile}
        affectedChatCount={input.affectedChatCount}
        onSwitchProfileForTask={input.onSwitchProfileForTask}
        onDismiss={() => undefined}
      />
    </TooltipProvider>,
  );
}

describe("rate-limit banner task-wide switch", () => {
  beforeEach(() => usage.entries.clear());
  afterEach(cleanup);

  it("hides the task-wide checkbox when only this chat is affected", () => {
    renderBanner({
      affectedChatCount: 1,
      destinations: undefined,
      primaryTarget: undefined,
      profiles: undefined,
      onSwitchProfile: () => undefined,
      onSwitchProfileForTask: () => undefined,
    });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Switch to Fresh profile" }),
    ).toBeDefined();
  });

  it("uses the shadcn button group with theme-neutral outline actions and opens the menu above", () => {
    renderBanner({
      affectedChatCount: 1,
      destinations: undefined,
      primaryTarget: undefined,
      profiles: undefined,
      onSwitchProfile: () => undefined,
      onSwitchProfileForTask: () => undefined,
    });

    const primaryAction = screen.getByRole("button", {
      name: "Switch to Fresh profile",
    });
    const menuTrigger = screen.getByRole("button", {
      name: "Choose another profile",
    });
    const group = primaryAction.closest('[data-slot="button-group"]');

    expect(group?.getAttribute("role")).toBe("group");
    expect(group?.getAttribute("aria-label")).toBe("Profile switch actions");
    expect(primaryAction.getAttribute("data-variant")).toBe("outline");
    expect(menuTrigger.getAttribute("data-variant")).toBe("outline");
    expect(within(primaryAction).getByText("Switch to")).toBeDefined();
    expect(within(primaryAction).getByText("Fresh profile")).toBeDefined();
    const dismiss = screen.getByRole("button", {
      name: "Dismiss rate-limit suggestion",
    });
    expect(dismiss.className).toContain("absolute");
    expect(dismiss.className).toContain("translate-x-1/2");
    expect(dismiss.className).toContain("-translate-y-1/2");
    expect(dismiss.parentElement?.getAttribute("aria-label")).toBe(
      "Rate-limit profile switch",
    );

    fireEvent.pointerDown(menuTrigger);

    expect(screen.getByRole("menu").getAttribute("data-side")).toBe("top");
  });

  it("provides native tooltips for the icon-only profile and dismiss actions", async () => {
    renderBanner({
      affectedChatCount: 1,
      destinations: undefined,
      primaryTarget: undefined,
      profiles: undefined,
      onSwitchProfile: () => undefined,
      onSwitchProfileForTask: () => undefined,
    });

    const menuTrigger = screen.getByRole("button", {
      name: "Choose another profile",
    });
    fireEvent.focus(menuTrigger);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "More profiles",
    );

    fireEvent.blur(menuTrigger);
    fireEvent.focus(
      screen.getByRole("button", { name: "Dismiss rate-limit suggestion" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("tooltip").textContent).toBe("Dismiss");
    });
  });

  it("places task scope below the action without duplicating it in the label", () => {
    const onSwitchProfile = vi.fn();
    const onSwitchProfileForTask = vi.fn();
    renderBanner({
      affectedChatCount: 3,
      destinations: undefined,
      primaryTarget: undefined,
      profiles: undefined,
      onSwitchProfile,
      onSwitchProfileForTask,
    });

    const checkbox = screen.getByRole("checkbox");
    const actionGroup = screen.getByRole("group", {
      name: "Profile switch actions",
    });
    expect(actionGroup.compareDocumentPosition(checkbox)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(checkbox.parentElement?.className).toContain("sm:col-start-2");
    expect(
      screen.getByText("Also switch 2 other chats in this task"),
    ).toBeDefined();
    expect(screen.queryByText(/Queued prompts in those chats/)).toBeNull();
    fireEvent.click(checkbox);
    expect(
      screen.getByRole("button", { name: "Switch to Fresh profile" }),
    ).toBeDefined();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Choose another profile" }),
    );
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Choose another profile" }),
    );
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Fresh profile" }),
    );
    expect(onSwitchProfile).toHaveBeenCalledWith(ALTERNATIVE.profileId);
    expect(onSwitchProfileForTask).toHaveBeenCalledWith(ALTERNATIVE.profileId);
  });

  it("uses the same immediate switch handler for a selectable menu row", () => {
    const onSwitchProfile = vi.fn();
    const onSwitchProfileForTask = vi.fn();
    renderBanner({
      affectedChatCount: 2,
      destinations: [destination(ALTERNATIVE, true), destination(SECOND, true)],
      profiles: [CURRENT, ALTERNATIVE, SECOND],
      primaryTarget: undefined,
      onSwitchProfile,
      onSwitchProfileForTask,
    });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Choose another profile" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Second profile/ }));
    expect(onSwitchProfile).toHaveBeenCalledWith(SECOND.profileId);
    expect(onSwitchProfileForTask).not.toHaveBeenCalled();
  });

  it("keeps unavailable rows inspectable and prevents dispatch", () => {
    const onSwitchProfile = vi.fn();
    const unavailable = destination(SECOND, false);
    renderBanner({
      affectedChatCount: 1,
      destinations: [destination(ALTERNATIVE, true), unavailable],
      profiles: [CURRENT, ALTERNATIVE, SECOND],
      primaryTarget: undefined,
      onSwitchProfile,
      onSwitchProfileForTask: () => undefined,
    });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Choose another profile" }),
    );
    const row = screen.getByRole("menuitem", { name: /Second profile/ });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(row);
    expect(onSwitchProfile).not.toHaveBeenCalled();
  });

  it("renders an all-unavailable warning as a read-only profile-limits menu", () => {
    const onSwitchProfile = vi.fn();
    const blocked = profile(
      "blocked-uuid",
      "managed",
      "Blocked profile",
      "hard_limit",
    );
    renderBanner({
      affectedChatCount: 1,
      destinations: [],
      primaryTarget: null,
      profiles: [CURRENT, blocked],
      onSwitchProfile,
      onSwitchProfileForTask: () => undefined,
    });
    expect(
      screen.getByRole("button", { name: "View profile limits" }),
    ).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "View profile limits" }),
    );
    expect(
      screen.getByRole("menuitem", { name: /Limited profile/ }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: /Blocked profile/ }),
    ).toBeDefined();
    expect(onSwitchProfile).not.toHaveBeenCalled();
  });

  it("preserves the composer's model and reasoning when committing a profile", () => {
    const store = createComposerToolbarStore({
      seedKey: "rate-limit-banner",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "claude",
          modelSlug: "sonnet-4.5",
          profileId: CURRENT.profileId,
        },
        reasoning: "high",
        serviceTier: "",
        agentMode: "regular",
      },
      onSettingsChange: null,
      tuiOnly: false,
    });
    renderBanner({
      affectedChatCount: 1,
      destinations: undefined,
      primaryTarget: undefined,
      profiles: undefined,
      onSwitchProfile: (profileId) => commitProfileSelection(store, profileId),
      onSwitchProfileForTask: () => undefined,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Fresh profile" }),
    );
    expect(store.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "sonnet-4.5",
      profileId: ALTERNATIVE.profileId,
    });
    expect(store.getState().reasoning).toBe("high");
  });

  it("reveals an ambient preview on hover and routes R only to its null-keyed entry", () => {
    const ambientRefresh = vi.fn(() => Promise.resolve());
    const limitedRefresh = vi.fn(() => Promise.resolve());
    const blockedRefresh = vi.fn(() => Promise.resolve());
    usage.entries.set(null, usageEntry(null, ambientRefresh));
    usage.entries.set(
      CURRENT.profileId,
      usageEntry(CURRENT.profileId, limitedRefresh),
    );
    usage.entries.set(
      BLOCKED.profileId,
      usageEntry(BLOCKED.profileId, blockedRefresh),
    );

    const ambientTarget = destination(AMBIENT, true);
    const blockedTarget = destination(BLOCKED, false);
    expect(ambientTarget.profileId).toBeNull();

    renderBanner({
      affectedChatCount: 1,
      destinations: [ambientTarget, blockedTarget],
      primaryTarget: ambientTarget,
      profiles: [CURRENT, AMBIENT, BLOCKED],
      onSwitchProfile: () => undefined,
      onSwitchProfileForTask: () => undefined,
    });

    expect(
      screen.getByRole("button", { name: "Switch to Terminal account" }),
    ).toBeDefined();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Choose another profile" }),
    );

    // Opening is passive: presentation is cache-only; no refresh is issued.
    expect(ambientRefresh).not.toHaveBeenCalled();
    expect(limitedRefresh).not.toHaveBeenCalled();
    expect(blockedRefresh).not.toHaveBeenCalled();

    const ambientRow = screen.getByRole("menuitem", {
      name: /Terminal account/,
    });
    expect(ambientRow.getAttribute("aria-label")).toMatch(/Main action target/);
    expect(screen.queryByText("Main action")).toBeNull();
    expect(screen.getByTestId("profile-usage-bar-null")).toBeDefined();
    expect(
      screen.queryByRole("complementary", {
        name: "Usage details for Terminal account",
      }),
    ).toBeNull();

    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "r" });
    expect(ambientRefresh).not.toHaveBeenCalled();

    fireEvent.pointerMove(ambientRow);
    const sidecar = screen.getByRole("complementary", {
      name: "Usage details for Terminal account",
    });
    expect(sidecar.getAttribute("data-profile-usage-sidecar")).toBe("");
    expect(
      screen.getByRole("button", {
        name: "Refresh usage for Terminal account",
      }),
    ).toBeDefined();

    fireEvent.keyDown(menu, { key: "r" });

    expect(ambientRefresh).toHaveBeenCalledTimes(1);
    expect(limitedRefresh).not.toHaveBeenCalled();
    expect(blockedRefresh).not.toHaveBeenCalled();
  });

  it("reveals the sidecar after deliberate keyboard navigation, not menu auto-focus", () => {
    usage.entries.set(
      ALTERNATIVE.profileId,
      usageEntry(ALTERNATIVE.profileId, () => Promise.resolve()),
    );
    renderBanner({
      affectedChatCount: 1,
      destinations: undefined,
      primaryTarget: undefined,
      profiles: undefined,
      onSwitchProfile: () => undefined,
      onSwitchProfileForTask: () => undefined,
    });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Choose another profile" }),
    );
    const row = screen.getByRole("menuitem", { name: /Fresh profile/ });
    // Real focus, matching Radix's genuine auto-focus-on-open: with a
    // single row, focus never moves again, so no further `focus` event
    // ever fires (see the production fix this test pins).
    row.focus();
    expect(screen.queryByRole("complementary")).toBeNull();

    fireEvent.keyDown(row, { key: "ArrowDown" });

    expect(
      screen.getByRole("complementary", {
        name: "Usage details for Fresh profile",
      }),
    ).toBeDefined();
  });
});
