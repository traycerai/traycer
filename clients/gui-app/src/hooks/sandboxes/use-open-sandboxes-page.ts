import { useCallback, useEffect } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  sandboxConfigurationOf,
  useSandboxConfigurations,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import type { SandboxPageConfiguration } from "@/lib/sandboxes/sandbox-row-lines";
import {
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import {
  clearRequestedSandboxesConfiguration,
  holdSandboxReveal,
  revealSandboxOnPage,
  useSandboxesPageStore,
  type SandboxesPageConfigurationId,
} from "@/stores/sandboxes/sandboxes-page-store";

/**
 * The configuration a revealed row is shown on, from the settled list and
 * teams: its team, else Personal, including once the row has left the list.
 */
function revealTarget(
  rows: readonly SandboxSummary[],
  sandboxId: string,
  configurations: readonly SandboxPageConfiguration[],
): SandboxesPageConfigurationId {
  const row = rows.find((summary) => summary.id === sandboxId) ?? null;
  const configuration =
    row === null ? null : sandboxConfigurationOf(row, configurations);
  return configuration?.kind === "team"
    ? { kind: "team", teamId: configuration.teamId }
    : { kind: "personal" };
}

/** The sandbox rows once the list and every team's environment are read. */
function useSettledSandboxRows(): {
  readonly rows: readonly SandboxSummary[] | null;
  readonly configurations: readonly SandboxPageConfiguration[];
} {
  const list = useSandboxList();
  const { configurations, complete } = useSandboxConfigurations();
  const rows = list.data?.sandboxes ?? null;
  return { rows: complete ? rows : null, configurations };
}

/**
 * Opens Settings › Sandboxes with one row revealed despite any filter: on the
 * configuration the row belongs to, read from the sandbox list (a push
 * carries only its entry key), or on Personal once the row has left the list.
 * Before the list and the teams settle, the reveal is held for the page to
 * place ({@link useSettlePendingSandboxReveal}).
 */
export function useOpenSandboxesPage(): (sandboxId: string) => void {
  const { rows, configurations } = useSettledSandboxRows();
  const { openSettings } = useSystemTabModalActions();
  return useCallback(
    (sandboxId: string) => {
      if (rows === null) {
        holdSandboxReveal(sandboxId);
      } else {
        revealSandboxOnPage(
          revealTarget(rows, sandboxId, configurations),
          sandboxId,
        );
      }
      openSettings({
        section: "sandboxes",
        resetToGeneral: false,
        tab: null,
        draft: null,
        hostId: null,
      });
    },
    [rows, configurations, openSettings],
  );
}

/** Places a held reveal on its configuration once the list and teams settle. */
export function useSettlePendingSandboxReveal(): void {
  const { rows, configurations } = useSettledSandboxRows();
  const pending = useSandboxesPageStore((s) =>
    s.revealConfigurationPending ? s.revealSandboxId : null,
  );
  useEffect(() => {
    if (pending === null || rows === null) return;
    revealSandboxOnPage(revealTarget(rows, pending, configurations), pending);
  }, [configurations, pending, rows]);
}

/** The group's pick for a configuration, or `null` until its team's environment is known. */
function environmentPickFor(
  configuration: SandboxesPageConfigurationId,
  configurations: readonly SandboxPageConfiguration[],
): EnvironmentPick | null {
  if (configuration.kind === "personal") return PERSONAL_PICK;
  const team = configurations.find(
    (candidate) =>
      candidate.kind === "team" && candidate.teamId === configuration.teamId,
  );
  if (team === undefined || team.kind !== "team") return null;
  return team.environmentId === null
    ? null
    : { kind: "team", environmentId: team.environmentId };
}

/**
 * Moves the Environment group's pick, which the page shows, to the
 * configuration a caller opened the page on, once that team's environment is
 * known. A team that never resolves leaves the pick where it is.
 */
export function useApplyRequestedSandboxesConfiguration(): void {
  const { configurations, complete } = useSandboxConfigurations();
  const requested = useSandboxesPageStore((s) => s.requestedConfiguration);
  useEffect(() => {
    if (requested === null) return;
    const pick = environmentPickFor(requested, configurations);
    if (pick === null && !complete) return;
    if (pick !== null) {
      useSettingsEnvironmentPickStore.getState().setPick(pick);
    }
    clearRequestedSandboxesConfiguration();
  }, [complete, configurations, requested]);
}
