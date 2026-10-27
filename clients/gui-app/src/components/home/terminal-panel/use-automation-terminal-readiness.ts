import { useState } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  sandboxListReadSentAt,
  useSandboxList,
} from "@/hooks/sandboxes/use-sandbox-list-query";
import { decodePendingSandboxObservation } from "@/lib/sandboxes/pending-sandbox-observation";

export interface AutomationTerminalAttempt {
  readonly userId: string | null;
  readonly terminalId: string;
  readonly hostId: string | null;
  readonly sandboxId: string | null;
  readonly startedAt: number;
  readonly knownSandbox: boolean;
}

/** A wake ends on fresh control-plane evidence, never an arbitrary deadline. */
export function useAutomationTerminalReadinessFailed(
  attempt: AutomationTerminalAttempt | null,
): boolean {
  const list = useSandboxList();
  const [seenTerminalId, setSeenTerminalId] = useState<string | null>(null);
  const [failedAttempt, setFailedAttempt] =
    useState<AutomationTerminalAttempt | null>(null);
  const row = list.data?.sandboxes.find(
    (candidate) => candidate.id === attempt?.sandboxId,
  );
  if (
    row !== undefined &&
    attempt !== null &&
    seenTerminalId !== attempt.terminalId
  ) {
    setSeenTerminalId(attempt.terminalId);
  }
  if (attempt === null || attempt.sandboxId === null) return false;
  const observed = decodePendingSandboxObservation(
    {
      createdAt: attempt.startedAt,
      createdSandbox: {
        sandboxId: attempt.sandboxId,
        rowSeen: attempt.knownSandbox || seenTerminalId === attempt.terminalId,
      },
    },
    automationHostObservation(row),
    {
      kind: "list",
      sentAt: sandboxListReadSentAt(list.data),
      mountedAt: attempt.startedAt,
      ...(row === undefined ? { missingSandboxId: attempt.sandboxId } : {}),
    },
  );
  const failed = observed === "resting" || observed === "ended";
  if (failed && failedAttempt !== attempt) setFailedAttempt(attempt);
  return failed || failedAttempt === attempt;
}

function automationHostObservation(
  row: SandboxSummary | undefined,
): "ended" | "resting" | "waking" | "awake" {
  if (row === undefined || row.frozen) return "ended";
  switch (row.state) {
    case "awake":
      return "awake";
    case "creating":
    case "starting":
    case "resuming":
      return "waking";
    case "released":
    case "suspended":
    case "suspending":
    case "stopped":
    case "stopping":
      return "resting";
    case "failed":
    case "destroying":
    case "destroyed":
      return "ended";
  }
}
