import { type ReactNode } from "react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { RunnerHostContext } from "@/providers/runner-host-context";

interface RunnerHostProviderProps {
  readonly runnerHost: IRunnerHost;
  readonly children: ReactNode;
}

/**
 * Shell-owned IRunnerHost, passed at bootstrap. If this mounted, the host is ready.
 */
export function RunnerHostProvider(props: RunnerHostProviderProps) {
  return (
    <RunnerHostContext.Provider value={props.runnerHost}>
      {props.children}
    </RunnerHostContext.Provider>
  );
}
