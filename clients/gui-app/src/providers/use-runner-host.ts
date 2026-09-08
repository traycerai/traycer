import { use } from "react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { RunnerHostContext } from "@/providers/runner-host-context";

export function useRunnerHost(): IRunnerHost {
  const value = use(RunnerHostContext);
  if (value === null) {
    throw new Error(
      "useRunnerHost must be called inside a <RunnerHostProvider>.",
    );
  }
  return value;
}

// Optional variant for components that must render outside a provider (e.g. the
// app header in host-less test harnesses). Returns null instead of throwing so
// a host-only affordance can degrade to nothing rather than crash the tree.
export function useRunnerHostOrNull(): IRunnerHost | null {
  return use(RunnerHostContext);
}
