import { useStore } from "zustand";
import { useEffect, useRef } from "react";
import type { TerminalSessionExitReason } from "@traycer/protocol/host/terminal/unary-schemas";
import type {
  TerminalLifecycleStatus,
  TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";

export function isTerminalCrashExit(input: {
  readonly status: TerminalLifecycleStatus;
  readonly exitCode: number | null;
  readonly exitReason: TerminalSessionExitReason | null;
  readonly isExitSuppressed: () => boolean;
}): boolean {
  // `killed` and `reaped` are lifecycle events, not process failures. The
  // current terminal protocol has no separate crash reason on live exit
  // frames, so a non-zero exit code is the authoritative signal there. Should
  // the protocol add a dedicated reason later, an unrecognized non-null reason
  // is deliberately treated as a crash too.
  const crashReason =
    input.exitReason !== null &&
    !["process-exit", "killed", "reaped"].includes(input.exitReason);
  const lifecycleExit =
    input.exitReason === "killed" || input.exitReason === "reaped";
  return (
    input.status === "exited" &&
    !input.isExitSuppressed() &&
    !lifecycleExit &&
    (crashReason || (input.exitCode !== null && input.exitCode !== 0))
  );
}

export function useTerminalCrashNotification(input: {
  readonly handle: TerminalSessionStoreHandle;
  readonly isExitSuppressed: () => boolean;
  readonly onCrashExit: () => void;
}): void {
  const { handle, isExitSuppressed, onCrashExit } = input;
  // Read via `useStore(api, selector)` rather than calling `handle.store(...)`
  // directly: the bound-store call form isn't recognizable as a hook to the
  // React Compiler, which memoizes it away and corrupts the hook order.
  const status = useStore(handle.store, (state) => state.status);
  const exitCode = useStore(handle.store, (state) => state.exitCode);
  const exitReason = useStore(handle.store, (state) => state.exitReason);
  const crashReportedRef = useRef(false);

  useEffect(() => {
    if (status !== "exited") {
      crashReportedRef.current = false;
      return;
    }
    if (crashReportedRef.current) return;
    if (
      !isTerminalCrashExit({
        status,
        exitCode,
        exitReason,
        isExitSuppressed,
      })
    ) {
      return;
    }
    crashReportedRef.current = true;
    onCrashExit();
  }, [status, exitCode, exitReason, isExitSuppressed, onCrashExit]);
}
