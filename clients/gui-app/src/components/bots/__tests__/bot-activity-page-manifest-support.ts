/**
 * What the suites of the reporting controls under the real negotiated manifest
 * share.
 */ import { Fragment, createElement, type ReactNode } from "react";
import {
  act,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { recordNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import {
  HOST_ID,
  Harness,
  REPORT_METHODS,
  periodic,
  row,
} from "@/components/bots/__tests__/bot-activity-page-support";

export const offer = (methods: ReadonlyArray<string>): void => {
  act(() => recordNegotiatedHostMethods(HOST_ID, ["host.status", ...methods]));
};
export const uiFor = (
  tasks: ReadonlyArray<BotTaskEntry>,
  boundHere: boolean,
): ReactNode =>
  createElement(
    Fragment,
    null,
    createElement("input", { "aria-label": "Outside" }),
    createElement(Harness, {
      threads: [],
      tasks: [...tasks, periodic("t-other", {})],
      boundHere,
      notificationSubscriptions: null,
    }),
  );
export const ui = (tasks: ReadonlyArray<BotTaskEntry>): ReactNode =>
  uiFor(tasks, true);
export const rowOf = (taskId: string): HTMLElement => {
  const found = screen
    .getByTestId("bot-activity-page")
    .querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
  if (found === null) throw new Error(`no row for ${taskId}`);
  return found;
};
export const mountReal = (): RenderResult => {
  mocks.state.realManifest = true;
  offer(REPORT_METHODS);
  return render(ui([periodic("t-every", {})]));
};
export const openButton = (): HTMLElement =>
  within(row("t-every")).getByTestId("bot-activity-task-open");
export const trigger = (): HTMLElement =>
  within(row("t-every")).getByRole("button", { name: "Reporting actions" });
export const outside = (): HTMLElement => screen.getByLabelText("Outside");
