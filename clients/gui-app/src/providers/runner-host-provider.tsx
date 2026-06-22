import { type ReactNode } from "react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { RunnerHostContext } from "@/providers/runner-host-context";

interface RunnerHostProviderProps {
  readonly runnerHost: IRunnerHost;
  readonly children: ReactNode;
}

/**
 * Thin synchronous context provider for the shell-owned `IRunnerHost`.
 *
 * Concrete shells (Electron, Capacitor, preview) construct their
 * `IRunnerHost` at bootstrap and pass it directly to `<TraycerApp />`,
 * which forwards it here. No module-level resolver, no async fallback,
 * no error boundary - if mount reached this provider, the host is ready.
 */
export function RunnerHostProvider(props: RunnerHostProviderProps) {
  return (
    <RunnerHostContext.Provider value={props.runnerHost}>
      {props.children}
    </RunnerHostContext.Provider>
  );
}
