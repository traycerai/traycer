import type { ReactNode } from "react";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

/**
 * The runner host a bot's message box reads (`useBotBoxImages` hands its file
 * drops to the paste adapter), for a suite that mounts the real box.
 */
const BOT_TEST_RUNNER_HOST = createFakeRunnerHost({});

export function BotTestRunnerHost(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <RunnerHostContext value={BOT_TEST_RUNNER_HOST}>
      {props.children}
    </RunnerHostContext>
  );
}
