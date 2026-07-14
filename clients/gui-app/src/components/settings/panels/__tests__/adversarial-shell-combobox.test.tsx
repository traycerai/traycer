import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IRunnerHost,
  TraycerDetectedShell,
} from "@traycer-clients/shared/platform/runner-host";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ShellProgramCombobox } from "@/components/settings/panels/shell/shell-program-combobox";

// Spy on the toast boundary so a Browse rejection can be asserted to route
// through it (and NOT surface as an unhandled promise rejection).
const toastSpy = vi.fn();
vi.mock("@/lib/runner-error-toast", () => ({
  toastFromRunnerError: (error: unknown, fallback: string): void => {
    toastSpy(error, fallback);
  },
}));

afterEach(() => {
  cleanup();
  toastSpy.mockReset();
});

const ZSH: TraycerDetectedShell = {
  name: "zsh",
  path: "/bin/zsh",
  isDefault: true,
  source: "detected",
  missing: false,
};

function makeHost(
  configure: ((cli: MockTraycerCli) => void) | undefined,
): IRunnerHost {
  const cli = new MockTraycerCli();
  configure?.(cli);
  return new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: cli,
  });
}

function renderCombobox(props: {
  readonly onAdd: ((path: string) => void) | undefined;
  readonly configure: ((cli: MockTraycerCli) => void) | undefined;
}) {
  const host = makeHost(props.configure);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <ShellProgramCombobox
          value="/bin/zsh"
          synthesised={false}
          shells={[ZSH]}
          disabled={false}
          onSelect={() => undefined}
          onAdd={props.onAdd ?? (() => undefined)}
          onRemove={() => undefined}
          onUseSystemDefault={() => undefined}
        />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function openPopover(): void {
  fireEvent.click(screen.getAllByRole("button")[0]);
}

describe("adversarial: Add-a-shell race conditions", () => {
  it("does not add on Enter pressed before the probe has resolved (pre-debounce)", () => {
    const onAdd = vi.fn();
    renderCombobox({
      onAdd,
      configure: (cli) => {
        cli.probeFs = new Map([["/usr/local/bin/nu", true]]);
      },
    });
    openPopover();
    const input = screen.getByRole("textbox", { name: "Add a shell by path" });
    // Type a valid path and immediately hit Enter, before the 250ms debounce +
    // probe can mark it green. `canAdd` must still be false.
    fireEvent.change(input, { target: { value: "/usr/local/bin/nu" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();
    // The ⏎ button is disabled until a fresh green probe.
    const addButton = screen.getByRole("button", { name: "Add this shell" });
    expect(addButton).toHaveProperty("disabled", true);
  });

  it("does not add the previous path's green probe after the input changes to a new path", async () => {
    const onAdd = vi.fn();
    renderCombobox({
      onAdd,
      configure: (cli) => {
        // A is executable; B exists but is not executable.
        cli.probeFs = new Map([
          ["/usr/local/bin/nu", true],
          ["/etc/hosts", false],
        ]);
      },
    });
    openPopover();
    const input = screen.getByRole("textbox", { name: "Add a shell by path" });

    // A goes green.
    fireEvent.change(input, { target: { value: "/usr/local/bin/nu" } });
    await screen.findByText("✓ found · executable");

    // Quickly switch to B and press Enter before B's probe resolves. The guard
    // `debounced === trimmedInput` makes `probe` undefined for the new value, so
    // neither A (no longer in the input) nor B (unproven) may be added.
    fireEvent.change(input, { target: { value: "/etc/hosts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("Browse of a non-executable file leaves it in the input (amber) and does not add", async () => {
    const onAdd = vi.fn();
    renderCombobox({
      onAdd,
      configure: (cli) => {
        cli.pickedProgramFile = "/etc/hosts";
        cli.probeFs = new Map([["/etc/hosts", false]]);
      },
    });
    openPopover();
    fireEvent.click(await screen.findByText("Browse…"));
    // The path lands in the input, the amber "not executable" hint shows, and
    // nothing is added.
    await screen.findByText("found, but not executable");
    expect(onAdd).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox", { name: "Add a shell by path" });
    expect((input as HTMLInputElement).value).toBe("/etc/hosts");
  });

  it("Browse rejection routes through the toast boundary with no unhandled rejection", async () => {
    const onAdd = vi.fn();
    renderCombobox({
      onAdd,
      configure: (cli) => {
        cli.pickShellProgramFile = () =>
          Promise.reject(new Error("dialog exploded"));
      },
    });
    openPopover();
    fireEvent.click(await screen.findByText("Browse…"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy.mock.calls[0]?.[1]).toBe("Failed to browse for a shell");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("Browse of an executable file adds it outright", async () => {
    const onAdd = vi.fn();
    renderCombobox({
      onAdd,
      configure: (cli) => {
        cli.pickedProgramFile = "/usr/local/bin/nu";
        cli.probeFs = new Map([["/usr/local/bin/nu", true]]);
      },
    });
    openPopover();
    fireEvent.click(await screen.findByText("Browse…"));
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith("/usr/local/bin/nu"),
    );
  });

  it("does not add when the probe reports the path is missing entirely", async () => {
    const onAdd = vi.fn();
    renderCombobox({
      onAdd,
      configure: (cli) => {
        cli.probeFs = new Map(); // nothing exists
      },
    });
    openPopover();
    const input = screen.getByRole("textbox", { name: "Add a shell by path" });
    fireEvent.change(input, { target: { value: "/does/not/exist" } });
    await screen.findByText("not found on this machine");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();
  });
});
