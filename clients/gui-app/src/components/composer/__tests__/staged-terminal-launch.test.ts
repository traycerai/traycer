import { describe, expect, it } from "vitest";
import {
  stagedResubmitReady,
  stagedTerminalLaunchOnHost,
} from "@/components/composer/staged-terminal-launch";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import type { ComposerToolbarState } from "@/stores/composer/composer-toolbar-store";
import {
  harnessRow,
  providerRow,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";

/** A Start put together on the old host: Codex with a profile of its own. */
const CAPTURED: TerminalAgentLaunch = {
  harnessId: "codex",
  model: "gpt-6.1-sol",
  reasoningEffort: "high",
  terminalAgentArgs: "--resume",
  profileId: "old-host-profile",
};

function catalog(
  harnesses: ComposerToolbarState["catalog"]["harnesses"],
): Pick<ComposerToolbarState, "catalog"> {
  return {
    catalog: {
      hostId: "sbx-host",
      chatLineCarriesAutoMode: null,
      ultracodeCarried: false,
      keepsUnavailablePick: false,
      harnesses,
      modelsHarnessId: "codex",
      models: [],
      modelsLoaded: true,
      tuiOnly: false,
    },
  };
}

describe("stagedTerminalLaunchOnHost", () => {
  it("launches the harness, model and arguments the person captured, whatever else the new host offers first", () => {
    const launch = stagedTerminalLaunchOnHost(
      CAPTURED,
      catalog([
        harnessRow("claude", { modes: ["gui", "tui"] }),
        harnessRow("codex", { modes: ["gui", "tui"] }),
      ]),
      [providerRow("codex", null)],
    );

    expect(launch).toEqual({
      harnessId: "codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      terminalAgentArgs: "--resume",
      // The new host offers no profile of that id: its own login.
      profileId: null,
    });
  });

  it("launches nothing when the captured harness is unavailable there, though another one is ready", () => {
    expect(
      stagedTerminalLaunchOnHost(
        CAPTURED,
        catalog([
          harnessRow("codex", { available: false }),
          harnessRow("claude", { available: true }),
        ]),
        [],
      ),
    ).toBeNull();
  });

  it.each([
    ["is not in the catalog", [harnessRow("claude", {})]],
    ["runs only in chat", [harnessRow("codex", { modes: ["gui"] })]],
  ])("launches nothing when the captured harness %s", (_label, harnesses) => {
    expect(
      stagedTerminalLaunchOnHost(CAPTURED, catalog(harnesses), []),
    ).toBeNull();
  });
});

describe("stagedResubmitReady", () => {
  const ANSWERED = { data: { providers: [] }, isError: false };

  it("waits on the Start's own harness pack, not on the toolbar's", () => {
    expect(
      stagedResubmitReady({
        catalogSettled: true,
        launch: CAPTURED,
        canSubmit: true,
        canStart: [true],
        providers: {
          data: {
            providers: [
              providerRow("codex", { status: "downloading", percent: 10 }),
              providerRow("claude-code", null),
            ],
          },
          isError: false,
        },
      }),
    ).toBe(false);
    expect(
      stagedResubmitReady({
        catalogSettled: true,
        launch: CAPTURED,
        canSubmit: true,
        canStart: [true],
        providers: {
          data: {
            providers: [
              providerRow("codex", { status: "installed" }),
              providerRow("claude-code", { status: "downloading", percent: 1 }),
            ],
          },
          isError: false,
        },
      }),
    ).toBe(true);
  });

  it("holds until the catalog and the providers have answered", () => {
    expect(
      stagedResubmitReady({
        catalogSettled: false,
        launch: CAPTURED,
        canSubmit: true,
        canStart: [true],
        providers: ANSWERED,
      }),
    ).toBe(false);
    expect(
      stagedResubmitReady({
        catalogSettled: true,
        launch: CAPTURED,
        canSubmit: true,
        canStart: [true],
        providers: { data: undefined, isError: false },
      }),
    ).toBe(false);
  });
});
