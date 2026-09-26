import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import type {
  ChatRunSettings,
  LastFailedAttempt,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatFallbackListTargetsResponse } from "@traycer/protocol/host/chat-fallback";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  RoutingDestinationPicker,
  type RoutingDestinationEntry,
} from "@/components/chat/fallback/routing-destination-picker";
import {
  CHAT_ID,
  EPIC_ID,
  SESSION_HOST_ID,
  TAB_HOST_ID,
  accounts,
  countdownPending,
  kit,
} from "./routing-picker-kit";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  fallbackModelTarget,
  fallbackProfileTarget,
  lastFailedAttempt,
  listTargetsResponse,
  providerProfile,
} from "./fallback-fixtures";

/**
 * The scene the routing chooser's suites share: one failed Claude tuple, one
 * sibling account, one Codex destination, the three entry points, and the
 * handful of queries every case asks of the open popover. Kept apart from
 * `routing-picker-kit.tsx` because that module is imported BY the `vi.mock`
 * factories, and this one imports the component those mocks stand behind.
 */

export const WORK_PROFILE = "work01-profile";
export const FAILED_PROFILE = "failed01-profile";
export const ATTEMPT_MESSAGE_ID = "user-msg-routing";
export const ATTEMPT_TURN_ID = "turn-routing";
export const RESETS_AT = new Date(2026, 5, 15, 15, 0, 0).getTime();

/**
 * The failed tuple every listing names. Its permission mode and agent mode are
 * not the composer's defaults, so a confirm that took either from anywhere but
 * this tuple is visible.
 */
export const FAILED: ChatRunSettings = {
  ...FAILED_CLAUDE_TUPLE,
  permissionMode: "auto_accept_edits",
  agentMode: "epic",
  reasoningEffort: null,
  serviceTier: null,
  profileId: FAILED_PROFILE,
};

export const TARGET: ChatRunSettings = {
  ...TARGET_CODEX_TUPLE,
  permissionMode: "auto_accept_edits",
  agentMode: "epic",
};

export function seedProviders(): void {
  kit.providers = [
    accounts(
      [
        providerProfile({
          profileId: FAILED_PROFILE,
          kind: "managed",
          label: "Personal",
          authenticated: true,
        }),
        providerProfile({
          profileId: WORK_PROFILE,
          kind: "managed",
          label: "Work",
          authenticated: true,
        }),
      ],
      "claude-code",
    ),
    accounts(
      [
        providerProfile({
          profileId: TARGET.profileId ?? "target01-profile",
          kind: "managed",
          label: "Codex Team",
          authenticated: true,
        }),
      ],
      "codex",
    ),
  ];
}

export function listing(input: {
  readonly recommendedWork: boolean;
}): ChatFallbackListTargetsResponse {
  return listTargetsResponse({
    outcome: "listed",
    failedTuple: FAILED,
    profileTargets: [
      fallbackProfileTarget({
        profileId: WORK_PROFILE,
        label: "Work",
        severity: "ok",
        usedPercent: 10,
        recommended: input.recommendedWork,
        selectable: true,
        skip: null,
      }),
    ],
    modelTargets: [
      fallbackModelTarget({
        groupId: "grp-internal-secret",
        harnessId: "codex",
        modelFamily: "gpt-5",
        model: "gpt-5",
        reasoningEffort: null,
        profileId: TARGET.profileId,
        severity: "ok",
        usedPercent: 20,
        target: TARGET,
        warnings: [],
        selectable: true,
        skip: null,
      }),
    ],
    modelTargetsSkip: null,
  });
}

export function failedAttempt(
  eligibleRungs: LastFailedAttempt["eligibleRungs"],
): LastFailedAttempt {
  return lastFailedAttempt({
    userMessageId: ATTEMPT_MESSAGE_ID,
    turnId: ATTEMPT_TURN_ID,
    failure: {
      reason: "rate_limit",
      resetsAt: RESETS_AT,
      resetsAtSource: "provider",
    },
    eligibleRungs,
    waitDisposition: "eligible",
    switchDisposition: "eligible",
    failedTuple: FAILED,
  });
}

export const HOLD_PENDING = countdownPending({
  state: "hold",
  revision: 1,
  queuedItemsMoving: 2,
});
export const CHOOSING_PENDING = countdownPending({
  state: "choosing",
  revision: 2,
  queuedItemsMoving: 2,
});

export function countdownAt(pending: PendingFallback): RoutingDestinationEntry {
  return { kind: "countdown", pending };
}

/** The countdown entry once the frame says `choosing`. */
export function countdown(): RoutingDestinationEntry {
  return countdownAt(CHOOSING_PENDING);
}

export function waiting(): RoutingDestinationEntry {
  return {
    kind: "waiting",
    pending: countdownPending({
      state: "waiting",
      revision: 3,
      queuedItemsMoving: 0,
    }),
  };
}

export function failedTurn(
  eligibleRungs: LastFailedAttempt["eligibleRungs"],
): RoutingDestinationEntry {
  return {
    kind: "failed-turn",
    attempt: failedAttempt(eligibleRungs),
    seedTuple: FAILED,
  };
}

export function chooser(
  entry: RoutingDestinationEntry,
  canAct: boolean,
): ReactElement {
  return (
    <TooltipProvider>
      <TabHostProvider hostId={TAB_HOST_ID}>
        <RoutingDestinationPicker
          entry={entry}
          triggerLabel="Choose differently…"
          triggerVariant="ghost"
          triggerDisabled={false}
          canAct={canAct}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={SESSION_HOST_ID}
        />
      </TabHostProvider>
    </TooltipProvider>
  );
}

export function mount(entry: RoutingDestinationEntry) {
  return mountAs(entry, true);
}

export function mountAs(entry: RoutingDestinationEntry, canAct: boolean) {
  const result = render(chooser(entry, canAct));
  return {
    ...result,
    rerenderWith: (next: RoutingDestinationEntry) => {
      result.rerender(chooser(next, canAct));
    },
  };
}

export async function open(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Choose differently…" }));
  return screen.findByRole("dialog", { name: "Select model" });
}

export function option(name: RegExp): HTMLElement {
  return screen.getByRole("option", { name });
}

export function confirmButton(label: string): HTMLButtonElement {
  const button = screen.getByRole("button", { name: label });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`expected "${label}" to be a button`);
  }
  return button;
}

/** The chooser's confirm, whatever it currently says. */
export function footerConfirm(): HTMLButtonElement {
  const dialog = screen.getByRole("dialog", { name: "Select model" });
  for (const label of ["Switch", "Retry", "Wait"]) {
    const found = within(dialog).queryByRole("button", { name: label });
    if (found instanceof HTMLButtonElement) return found;
  }
  throw new Error("the chooser has no confirm button");
}

export function statusLines(): string[] {
  return screen
    .getAllByRole("status")
    .map((element) => element.textContent)
    .filter((text) => text.length > 0);
}
