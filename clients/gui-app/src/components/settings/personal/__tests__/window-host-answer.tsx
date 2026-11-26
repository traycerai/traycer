import type { ReactNode } from "react";
import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useWindowHostRunsPersonal } from "@/components/settings/personal/use-window-host-runs-personal";
import { WindowHostAnswerContext } from "@/components/settings/personal/window-host-answer-context";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * The window host's answer for a frame mounted without the page's gate
 * (`PageOrNotOnComputer`), which provides it in the app. It is read on the
 * frame's own scope, so the case's host decides which source draws, and it
 * renders again whenever the pick is set, as the gate does: a mock scope has no
 * subscribers, so a case that moves its host sets the pick again.
 */
export function UngatedWindowHostAnswer(props: {
  readonly children: ReactNode;
}): ReactNode {
  useEnvironmentPick();
  const windowHost = useWindowHostRunsPersonal(usePersonalHostScope());
  return (
    <WindowHostAnswerContext value={windowHost}>
      {props.children}
    </WindowHostAnswerContext>
  );
}
