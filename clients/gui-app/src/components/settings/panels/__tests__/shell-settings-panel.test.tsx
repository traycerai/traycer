// The panel is host-scoped now (shell config / log levels are fields of the
// selected host's own config), so it reads `useHostScope`. Mock at that
// boundary: these suites render the panel bare, without the host runtime and
// query providers the real hook needs.
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture({}),
  };
});
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IRunnerHost,
  TraycerShellConfigSetInput,
} from "@traycer-clients/shared/platform/runner-host";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";

afterEach(() => {
  cleanup();
});

// A non-login program: its family default is no flags, so switching to it must
// swap the flags row away from the login shell's "-i -l".
const CAT = {
  name: "cat",
  path: "/bin/cat",
  isDefault: false,
  source: "detected" as const,
  missing: false,
};

const SAVED_FLASH_MS = 1600;

function renderPanel(configure: (cli: MockTraycerCli) => void): MockTraycerCli {
  const cli = new MockTraycerCli();
  configure(cli);
  const host: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: cli,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <ShellSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return cli;
}

function statusTexts(): string[] {
  return screen.getAllByRole("status").map((node) => node.textContent);
}

describe("<ShellSettingsPanel /> hierarchy", () => {
  it("labels the two cards with scope tags and puts the effective command first", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });

    const preview = await screen.findByLabelText("Effective shell command");
    const terminalCard = screen.getByTestId("terminal-shell-settings");
    const envCard = screen.getByTestId("host-environment-settings");

    expect(
      within(terminalCard).getByRole("heading", {
        name: "Terminal shell · New terminals",
      }),
    ).toBeTruthy();
    expect(
      within(envCard).getByRole("heading", {
        name: "Host environment · After restart",
      }),
    ).toBeTruthy();

    // Cards do not repeat their external labels as internal headings, and the
    // pre-redesign "Environment variables" / bare "Shell" card titles are gone.
    expect(
      within(terminalCard).queryByRole("heading", { name: "Shell" }),
    ).toBeNull();
    expect(
      within(envCard).queryByRole("heading", {
        name: "Environment variables",
      }),
    ).toBeNull();

    const programLabel = within(terminalCard).getByText("Shell program");
    expect(
      preview.compareDocumentPosition(programLabel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(preview).getByText("effective command")).toBeTruthy();
    expect(within(preview).getByText("/bin/zsh")).toBeTruthy();
    expect(within(preview).getByText("-i -l")).toBeTruthy();
  });

  it("does not reserve a persistent visible Saved footer or status line", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });

    await screen.findByText("Startup flags for zsh");

    // Pre-redesign SaveStatus always painted a visible "Saved" chip in the
    // card footers. Idle chrome must stay quiet.
    expect(screen.queryByText(/^Saved$/)).toBeNull();
    expect(screen.queryByText(/^Saving…$/)).toBeNull();
    expect(screen.queryByTestId("settings-shell-saving-spinner")).toBeNull();
    expect(
      screen.queryByTestId("settings-shell-program-saving-spinner"),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-shell-flags-saving-spinner"),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-shell-environment-saving-spinner"),
    ).toBeNull();

    const statuses = screen.getAllByRole("status");
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(status.classList.contains("sr-only")).toBe(true);
      expect(status.textContent).toBe("");
    }
  });

  it("announces transient saving/saved feedback beside the changed control", async () => {
    // Real timers only: waitFor + fake timers race easily, and the deferred
    // CLI mutation already gives a stable pending window.
    // Gate holds the mutation in pending; setFinished resolves only after the
    // full shellConfigSet (gate + originalSet) completes — not merely after
    // the gate opens.
    let releaseGate: (() => void) | null = null;
    const setGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let resolveSetFinished: (() => void) | null = null;
    const setFinished = new Promise<void>((resolve) => {
      resolveSetFinished = resolve;
    });

    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
      const originalSet = cli.shellConfigSet.bind(cli);
      cli.shellConfigSet = async (
        input: TraycerShellConfigSetInput,
      ): Promise<void> => {
        await setGate;
        try {
          await originalSet(input);
        } finally {
          resolveSetFinished?.();
        }
      };
    });

    await screen.findByText("Startup flags for zsh");

    // Live regions mount at the terminal group root (program first, flags
    // second), outside the config-dependent skeleton/content branch.
    const terminalGroup = screen.getByTestId("terminal-shell-settings");
    const terminalStatuses = within(terminalGroup).getAllByRole("status");
    expect(terminalStatuses.length).toBe(2);
    const flagsStatus = terminalStatuses[1];
    expect(flagsStatus.textContent).toBe("");

    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    await waitFor(() => {
      expect(
        screen.getByTestId("settings-shell-flags-saving-spinner"),
      ).toBeTruthy();
      // Same DOM node as idle; only text changes (fails if status remounts).
      expect(flagsStatus.textContent).toBe("Startup flags saving");
    });
    expect(
      within(screen.getByTestId("terminal-shell-settings")).getAllByRole(
        "status",
      )[1],
    ).toBe(flagsStatus);
    expect(
      screen.queryByTestId("settings-shell-program-saving-spinner"),
    ).toBeNull();
    // No permanent visible Saved/Saving label during the transient path either.
    expect(screen.queryByText(/^Saved$/)).toBeNull();
    expect(screen.queryByText(/^Saving…$/)).toBeNull();

    await act(async () => {
      releaseGate?.();
      await setFinished;
    });

    // Re-query the second group-root status so remounts are distinguished
    // from sync races on the captured reference.
    await waitFor(() => {
      expect(
        screen.queryByTestId("settings-shell-flags-saving-spinner"),
      ).toBeNull();
      const liveStatus = within(
        screen.getByTestId("terminal-shell-settings"),
      ).getAllByRole("status")[1];
      expect(liveStatus.textContent).toBe("Startup flags saved");
      expect(liveStatus).toBe(flagsStatus);
    });

    await waitFor(
      () => {
        const liveStatus = within(
          screen.getByTestId("terminal-shell-settings"),
        ).getAllByRole("status")[1];
        expect(liveStatus.textContent).toBe("");
        expect(liveStatus).toBe(flagsStatus);
        expect(statusTexts().every((text) => text === "")).toBe(true);
      },
      { timeout: SAVED_FLASH_MS + 1000 },
    );
  });
});

describe("<ShellSettingsPanel /> flags row", () => {
  it("names the flags row after the shell and shows the profile helper for a login shell", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });
    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.getByText(/loads your full shell profile/)).toBeTruthy();
  });

  it("swaps the flags row to the newly-selected shell (label + helper + chips)", async () => {
    renderPanel((cli) => {
      // Synthesised so the picker trigger reads "System default" (unambiguous
      // to target), while the flags row still names the resolved login shell.
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
      cli.detectedShells = [
        {
          name: "zsh",
          path: "/bin/zsh",
          isDefault: true,
          source: "detected",
          missing: false,
        },
        CAT,
      ];
    });

    // Starts on the login shell: profile helper present, flag chips shown.
    await screen.findByText("Startup flags for zsh");
    expect(screen.getByText(/loads your full shell profile/)).toBeTruthy();
    expect(screen.getByText("-i")).toBeTruthy();

    // Open the picker (its trigger reads "System default") and select cat.
    const trigger = screen.getByText("System default").closest("button");
    if (trigger === null) throw new Error("no picker trigger");
    fireEvent.click(trigger);
    const catRow = screen
      .getAllByRole("option")
      .find((row) => row.textContent.includes("/bin/cat"));
    if (catRow === undefined) throw new Error("no /bin/cat row");
    fireEvent.click(catRow);

    // The flags row follows the selection: label names cat, the profile helper
    // is replaced by the plain launch helper, and the login flags are gone.
    expect(await screen.findByText("Startup flags for cat")).toBeTruthy();
    expect(
      screen.getByText("Passed to cat each time a terminal opens."),
    ).toBeTruthy();
    expect(screen.queryByText(/loads your full shell profile/)).toBeNull();
    expect(await screen.findByText("No flags")).toBeTruthy();
  });

  it("keeps the System default row checked when editing flags on it", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });

    await screen.findByText("Startup flags for zsh");
    // The trigger reads "System default" — the auto state is active.
    expect(screen.getByText("System default")).toBeTruthy();

    // Add a flag chip via the "＋ flag" affordance. (Exact name: the
    // "Restore default flags" button also contains "flag".)
    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    // The new flag persists to the login shell's entry, but the selection stays
    // on the system default: the trigger still reads "System default".
    expect(await screen.findByText("-x")).toBeTruthy();
    expect(screen.getByText("System default")).toBeTruthy();
    expect(screen.getByText("Startup flags for zsh")).toBeTruthy();
  });

  // Restore stays on the flags row and is gated by `disabled`: predictable
  // placement, enabled exactly while the visible flags deviate from the
  // selected shell's family default.
  it("disables Restore default flags when the flags match the family default", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"], // == family default for a login shell
        synthesised: true,
      };
    });
    await screen.findByText("Startup flags for zsh");
    const restore = screen.getByRole("button", {
      name: "Restore default flags",
    });
    expect(restore.hasAttribute("disabled")).toBe(true);
  });

  it("enables Restore default flags on a deviation and restores on click", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i"], // deviates from the -i -l family default
        synthesised: false,
      };
      cli.shellEntries = [{ path: "/bin/zsh", args: ["-i"] }];
    });

    // Wait for the config to load (the button renders immediately but stays
    // disabled until then), then it's enabled because the flags deviate.
    await screen.findByText("Startup flags for zsh");
    const restore = screen.getByRole("button", {
      name: "Restore default flags",
    });
    expect(restore.hasAttribute("disabled")).toBe(false);
    fireEvent.click(restore);

    // Flags return to the family default; the button stays rendered but is
    // disabled again.
    expect(await screen.findByText("-l")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Restore default flags" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
