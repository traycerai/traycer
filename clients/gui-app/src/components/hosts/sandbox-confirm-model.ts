import { toast } from "sonner";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { SandboxLifecycleVerb } from "@traycer/protocol/host/sandbox-control";
import type { SandboxVerbOutcome } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import {
  formatSandboxDate,
  sandboxSessionKindNames,
  type SandboxSessionReport,
} from "@/lib/sandboxes/sandbox-row-lines";

/** The sentences and helpers of `sandbox-confirm-dialogs.tsx`, kept apart so
 * that file exports components only. */

export const SANDBOX_SESSIONS_CAPTION =
  "Known running agents and Task terminals. Other sessions may also be interrupted.";

const MS_PER_MINUTE = 60_000;

const VERB_DONE: Record<SandboxLifecycleVerb, string> = {
  suspend: "Suspended",
  resume: "Resumed",
  stop: "Stopped",
  start: "Started",
};

const VERB_MOVING: Record<SandboxLifecycleVerb, string> = {
  suspend: "Suspending",
  resume: "Resuming",
  stop: "Stopping",
  start: "Starting",
};

/**
 * The verb whose done word names the state the row reached, which need not
 * be the one pressed: a suspend whose purge found the guest unreachable
 * lands `stopped`.
 */
function verbReached(
  pressed: SandboxLifecycleVerb,
  state: HostSandboxState | null,
): SandboxLifecycleVerb {
  switch (state) {
    case "suspended":
      return "suspend";
    case "stopped":
      return "stop";
    default:
      return pressed;
  }
}

/** Says where a lifecycle verb left the sandbox. */
export function toastSandboxVerbOutcome(
  verb: SandboxLifecycleVerb,
  outcome: SandboxVerbOutcome,
  name: string,
): void {
  if (outcome.kind === "settled") {
    toast.success(`${VERB_DONE[verbReached(verb, outcome.state)]} ${name}`);
  } else if (outcome.kind === "moving") {
    toast.info(`${VERB_MOVING[verb]} ${name}…`);
  }
}

export const NOTHING_IS_RUNNING_ON_IT = "Nothing is running on it.";

/**
 * The Destroy sentence's first clause: `Destroying ends 1 agent and
 * 2 terminals.` from the live split, or that nothing runs on a sandbox whose
 * processes have ended (`runsNothing`) or whose live count is zero.
 */
export function sandboxDestroySessionsSentence(
  report: SandboxSessionReport,
  team: boolean,
  runsNothing: boolean,
): string {
  if (runsNothing) return NOTHING_IS_RUNNING_ON_IT;
  const others = team ? ", including other members' running agents." : ".";
  if (report.kind === "live") {
    if (report.count === 0) return NOTHING_IS_RUNNING_ON_IT;
    const kinds = sandboxSessionKindNames(report);
    if (kinds.length > 0) {
      return `Destroying ends ${kinds.join(" and ")}${others}`;
    }
    const noun = report.count === 1 ? "session" : "sessions";
    return `Destroying ends ${report.count} running ${noun}${others}`;
  }
  return `Destroying ends every running session${others}`;
}

/**
 * The Stop dialog's destroy date: `Destroyed on Oct 26 at 10:36 unless
 * started.` counted from now, or `null` on a sandbox kept until destroyed
 * (`0` is never, as the server spells it).
 */
export function sandboxStopDestroySentence(
  restingMinutes: number | null,
  now: number,
): string | null {
  if (restingMinutes === null || restingMinutes === 0) return null;
  return `Destroyed on ${formatSandboxDate(now + restingMinutes * MS_PER_MINUTE, true)} unless started.`;
}

/**
 * What the typed confirmation still needs: `null` once the name matches, an
 * empty reason while nothing is typed (confirm disabled, no sentence), and
 * the instruction once something is typed.
 */
export function sandboxTypedNameReason(
  typed: string,
  name: string,
): string | null {
  if (typed.trim() === name) return null;
  return typed.length === 0 ? "" : `Type ${name} below to destroy it.`;
}

/**
 * The Never preview, three whole sentences: `kept until you destroy it` is
 * a mid-sentence clause elsewhere, so it is not reused here.
 */
const KEPT_FOREVER_PREVIEW =
  "Kept until you destroy it. Never applies to idle cleanup. Out-of-credit sandboxes are deleted after 30 days frozen.";

/** The resting period's preview: the date a save from now would set. */
export function sandboxRestingPreview(
  minutes: number | null,
  now: number,
): string {
  if (minutes === null) {
    return KEPT_FOREVER_PREVIEW;
  }
  if (Number.isNaN(minutes)) return "";
  return `Destroyed on ${formatSandboxDate(now + minutes * MS_PER_MINUTE, true)} if it rests from now.`;
}
