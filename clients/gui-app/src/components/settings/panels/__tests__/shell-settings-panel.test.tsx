import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";

afterEach(cleanup);

// A non-login program: its family default is no flags, so switching to it must
// swap the flags row away from the login shell's "-i -l".
const CAT = {
  name: "cat",
  path: "/bin/cat",
  isDefault: false,
  source: "detected" as const,
  missing: false,
};

function renderPanel(configure: (cli: MockTraycerCli) => void): void {
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
}

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

    // Add a flag chip via the "＋ flag" affordance. (Exact name: the footer's
    // always-rendered "Restore default flags" button also contains "flag".)
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

  // The Restore affordance is always rendered in the card footer and gated by
  // `disabled`: predictable placement, enabled exactly while the visible flags
  // deviate from the selected shell's family default.
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

    // Wait for the config to load (the footer button renders immediately but
    // stays disabled until then), then it's enabled because the flags deviate.
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
