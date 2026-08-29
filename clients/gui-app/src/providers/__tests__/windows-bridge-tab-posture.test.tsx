import "../../../__tests__/test-browser-apis";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WindowsBridgeProvider } from "@/providers/windows-bridge-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  getTabSplitCompatibility,
  setTabSplitCompatibility,
} from "@/stores/tabs/tab-split-compatibility";
import { createFakeRunnerHost } from "../../../__tests__/create-fake-runner-host";

/**
 * Both shells that reach this provider without a desktop windows bridge - the
 * one that draws its own tab layer and the one whose surroundings supply the
 * contexts - and the posture each is left in.
 *
 * The split flag is the readable half of that posture: a shell with no strip
 * can neither split one nor keep an arrangement of one, so it must not be left
 * in the state that says it can.
 */
function renderWithTabPosture(hasAppTabs: boolean): void {
  render(
    <RunnerHostProvider runnerHost={createFakeRunnerHost({ hasAppTabs })}>
      <WindowsBridgeProvider>
        <div />
      </WindowsBridgeProvider>
    </RunnerHostProvider>,
  );
}

describe("windows bridge tab posture", () => {
  beforeEach(() => {
    // Neither value: a test that started from the answer it expects could not
    // tell a real transition from an untouched default.
    setTabSplitCompatibility(false);
  });

  afterEach(() => {
    cleanup();
    setTabSplitCompatibility(true);
  });

  it("permits splits for a bridgeless shell that draws its own tabs", () => {
    renderWithTabPosture(true);

    expect(getTabSplitCompatibility().supported).toBe(true);
  });

  it("refuses splits for a shell whose surroundings own the tabs", () => {
    setTabSplitCompatibility(true);

    renderWithTabPosture(false);

    expect(getTabSplitCompatibility().supported).toBe(false);
  });
});
