import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { sandboxSettingsFailureLine } from "@traycer/protocol/host/sandbox-settings";
import type { EnvironmentNotificationDetail } from "@/lib/notifications/environment-notification-detail";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { settingsDidntApplyOnLine } from "@/lib/sandboxes/sandbox-strings";

export type SandboxApplyFailedDetail = Extract<
  EnvironmentNotificationDetail,
  { kind: "environment_apply_failed" }
>;

/**
 * The notice's sandbox as the list has it now: `undefined` until the list
 * answers, `null` once it answers without it (the sandbox is gone).
 */
export function useSandboxSettingsNoticeRow(
  hostId: string,
): SandboxSummary | null | undefined {
  const data = useSandboxList().data;
  if (data === undefined || data === null) return undefined;
  return (
    data.sandboxes.find((candidate) => candidate.hostId === hostId) ?? null
  );
}

/** An unanswered list keeps the host's own line, which was true when sent. */
export function sandboxSettingsNoticeSaysAwake(
  row: SandboxSummary | null | undefined,
): boolean {
  return row === undefined || row?.state === "awake";
}

/** The notice's one line, by the row's current state. */
export function useSandboxSettingsNoticeTitle(
  detail: SandboxApplyFailedDetail,
  fallback: string,
): string {
  const row = useSandboxSettingsNoticeRow(detail.hostId);
  const evidence = detail.sandbox;
  if (evidence === null || evidence === undefined) return fallback;
  return sandboxSettingsNoticeSaysAwake(row)
    ? sandboxSettingsFailureLine(
        evidence.name,
        evidence.configurationName,
        "SBX-0520",
      )
    : settingsDidntApplyOnLine(
        evidence.configurationName,
        evidence.name,
        "SBX-0520",
      );
}
