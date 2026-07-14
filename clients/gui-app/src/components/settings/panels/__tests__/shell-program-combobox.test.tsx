import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

afterEach(cleanup);

const ZSH: TraycerDetectedShell = {
  name: "zsh",
  path: "/bin/zsh",
  isDefault: true,
  source: "detected",
  missing: false,
};
const BASH: TraycerDetectedShell = {
  name: "bash",
  path: "/bin/bash",
  isDefault: false,
  source: "detected",
  missing: false,
};
const NU_ADDED: TraycerDetectedShell = {
  name: "nu",
  path: "/usr/local/bin/nu",
  isDefault: false,
  source: "added",
  missing: false,
};
const FISH_MISSING: TraycerDetectedShell = {
  name: "fish",
  path: "/usr/bin/fish",
  isDefault: false,
  source: "added",
  missing: true,
};

function makeHost(configure: (cli: MockTraycerCli) => void): IRunnerHost {
  const cli = new MockTraycerCli();
  configure(cli);
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
  readonly value: string;
  readonly synthesised: boolean;
  readonly shells: readonly TraycerDetectedShell[];
  readonly onSelect?: (path: string) => void;
  readonly onAdd?: (path: string) => void;
  readonly onRemove?: (path: string) => void;
  readonly onUseSystemDefault?: () => void;
  readonly configure?: (cli: MockTraycerCli) => void;
}) {
  const host = makeHost(props.configure ?? (() => undefined));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <ShellProgramCombobox
          value={props.value}
          synthesised={props.synthesised}
          shells={props.shells}
          disabled={false}
          onSelect={props.onSelect ?? (() => undefined)}
          onAdd={props.onAdd ?? (() => undefined)}
          onRemove={props.onRemove ?? (() => undefined)}
          onUseSystemDefault={props.onUseSystemDefault ?? (() => undefined)}
        />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function openPopover(): void {
  // Before opening, the combobox renders only its trigger button.
  fireEvent.click(screen.getAllByRole("button")[0]);
}

// The System default row and every concrete row share role="option", so target
// the concrete rows by the path text they render, excluding the System default
// row (which carries the migrated reset test id).
function concreteRow(pathText: string): HTMLElement {
  const rows = screen
    .getAllByRole("option")
    .filter(
      (row) => row.getAttribute("data-testid") !== "settings-shell-reset",
    );
  const match = rows.find((row: Node) =>
    (row.textContent ?? "").includes(pathText),
  );
  if (match === undefined) {
    throw new Error(`no concrete row rendering "${pathText}"`);
  }
  return match;
}

describe("<ShellProgramCombobox />", () => {
  it("labels the trigger 'System default' when synthesised, the shell name otherwise", () => {
    renderCombobox({ value: "/bin/zsh", synthesised: true, shells: [ZSH] });
    expect(screen.getByText("System default")).toBeTruthy();
    cleanup();
    renderCombobox({ value: "/bin/zsh", synthesised: false, shells: [ZSH] });
    expect(screen.queryByText("System default")).toBeNull();
    expect(screen.getByText("zsh")).toBeTruthy();
  });

  it("checks the stored concrete row, shows no 'default' tag, and ✕ only on added rows", async () => {
    renderCombobox({
      value: "/bin/zsh",
      synthesised: false,
      shells: [ZSH, BASH, NU_ADDED],
    });
    openPopover();

    // System default row present but unchecked (a concrete shell is stored).
    const systemDefault = await screen.findByTestId("settings-shell-reset");
    expect(systemDefault.getAttribute("aria-selected")).toBe("false");
    // The stored concrete row (zsh) is the checked one.
    expect(concreteRow("/bin/zsh").getAttribute("aria-selected")).toBe("true");
    // The old per-row "default" mini-tag is gone.
    expect(screen.queryByText("default")).toBeNull();
    // ✕ appears only for the added shell.
    expect(screen.getByRole("button", { name: "Remove nu" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove zsh" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove bash" })).toBeNull();
  });

  it("renders a System default row: default entry info, checked iff synthesised, click resets", async () => {
    const onUseSystemDefault = vi.fn();
    const onSelect = vi.fn();
    renderCombobox({
      value: "/bin/zsh",
      synthesised: true,
      shells: [ZSH, BASH, NU_ADDED],
      onUseSystemDefault,
      onSelect,
    });
    openPopover();

    const systemDefault = await screen.findByTestId("settings-shell-reset");
    expect(systemDefault.textContent).toContain("System default");
    expect(systemDefault.textContent).toContain("/bin/zsh");
    // Checked when synthesised; the concrete zsh row is NOT checked.
    expect(systemDefault.getAttribute("aria-selected")).toBe("true");
    expect(concreteRow("/bin/zsh").getAttribute("aria-selected")).toBe("false");

    fireEvent.click(systemDefault);
    expect(onUseSystemDefault).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("pins the login shell on an explicit pick from auto mode", async () => {
    const onUseSystemDefault = vi.fn();
    const onSelect = vi.fn();
    // While synthesised, `value` already equals the default path - clicking the
    // concrete row must still store it so the choice stops following the login
    // shell.
    renderCombobox({
      value: "/bin/zsh",
      synthesised: true,
      shells: [ZSH, BASH],
      onUseSystemDefault,
      onSelect,
    });
    openPopover();
    await screen.findByTestId("settings-shell-reset");

    fireEvent.click(concreteRow("/bin/zsh"));
    expect(onSelect).toHaveBeenCalledWith("/bin/zsh");
    expect(onUseSystemDefault).not.toHaveBeenCalled();
  });

  it("selects a different concrete row via onSelect", async () => {
    const onSelect = vi.fn();
    const onUseSystemDefault = vi.fn();
    renderCombobox({
      value: "/bin/zsh",
      synthesised: false,
      shells: [ZSH, BASH],
      onSelect,
      onUseSystemDefault,
    });
    openPopover();
    await screen.findByTestId("settings-shell-reset");

    fireEvent.click(concreteRow("/bin/bash"));
    expect(onSelect).toHaveBeenCalledWith("/bin/bash");
    expect(onUseSystemDefault).not.toHaveBeenCalled();
  });

  it("renders a transient checked row for a selection that is neither detected nor added", async () => {
    renderCombobox({
      value: "/opt/weird/mysh",
      synthesised: false,
      shells: [ZSH, BASH],
    });
    openPopover();
    await screen.findByTestId("settings-shell-reset");

    const transient = concreteRow("/opt/weird/mysh");
    expect(transient.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("button", { name: "Remove mysh" })).toBeNull();
  });

  it("flags a missing added shell in amber, still selectable and removable", async () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    renderCombobox({
      value: "/bin/zsh",
      synthesised: false,
      shells: [ZSH, FISH_MISSING],
      onSelect,
      onRemove,
    });
    openPopover();
    await screen.findByTestId("settings-shell-reset");

    // The quiet "not found" hint marks the vanished shell, and its path takes
    // the amber (--term-ansi-yellow) validation tone.
    expect(screen.getByText("not found")).toBeTruthy();
    const row = concreteRow("/usr/bin/fish");
    expect(row.innerHTML).toContain("term-ansi-yellow");
    // A missing row is still removable...
    expect(screen.getByRole("button", { name: "Remove fish" })).toBeTruthy();
    // ...and still selectable.
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("/usr/bin/fish");
  });

  it("removes an added shell via ✕ without invoking select", async () => {
    const onRemove = vi.fn();
    const onSelect = vi.fn();
    renderCombobox({
      value: "/bin/zsh",
      synthesised: false,
      shells: [ZSH, NU_ADDED],
      onRemove,
      onSelect,
    });
    openPopover();

    fireEvent.click(await screen.findByRole("button", { name: "Remove nu" }));
    expect(onRemove).toHaveBeenCalledWith("/usr/local/bin/nu");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])(
    "keeps %j activation of the nested remove button from selecting its row",
    async (key) => {
      const onRemove = vi.fn();
      const onSelect = vi.fn();
      renderCombobox({
        value: "/bin/zsh",
        synthesised: false,
        shells: [ZSH, NU_ADDED],
        onRemove,
        onSelect,
      });
      openPopover();

      const removeButton = await screen.findByRole("button", {
        name: "Remove nu",
      });
      fireEvent.keyDown(removeButton, { key });
      fireEvent.click(removeButton);

      expect(onRemove).toHaveBeenCalledWith("/usr/local/bin/nu");
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("hides the Browse row when the file-dialog capability is absent", async () => {
    renderCombobox({
      value: "/bin/zsh",
      synthesised: false,
      shells: [ZSH],
      configure: (cli) => {
        cli.pickShellProgramFile = null;
      },
    });
    openPopover();
    await screen.findByRole("textbox", { name: "Add a shell by path" });
    expect(screen.queryByText("Browse…")).toBeNull();
  });

  it("shows the Browse row when the file-dialog capability is present", async () => {
    renderCombobox({ value: "/bin/zsh", synthesised: false, shells: [ZSH] });
    openPopover();
    expect(await screen.findByText("Browse…")).toBeTruthy();
  });

  it("adds a typed path only when the probe reports found + executable", async () => {
    const onAdd = vi.fn();
    renderCombobox({
      value: "/bin/zsh",
      synthesised: false,
      shells: [ZSH],
      onAdd,
      configure: (cli) => {
        cli.probeFs = new Map([["/usr/local/bin/nu", true]]);
      },
    });
    openPopover();

    const input = screen.getByRole("textbox", { name: "Add a shell by path" });
    fireEvent.change(input, { target: { value: "/usr/local/bin/nu" } });
    await screen.findByText("✓ found · executable");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).toHaveBeenCalledWith("/usr/local/bin/nu");
  });

  it("blocks add when the probe reports found but not executable", async () => {
    const onAdd = vi.fn();
    renderCombobox({
      value: "/bin/zsh",
      synthesised: false,
      shells: [ZSH],
      onAdd,
      configure: (cli) => {
        cli.probeFs = new Map([["/etc/hosts", false]]);
      },
    });
    openPopover();

    const input = screen.getByRole("textbox", { name: "Add a shell by path" });
    fireEvent.change(input, { target: { value: "/etc/hosts" } });
    await screen.findByText("found, but not executable");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("requires an absolute path before probing", async () => {
    renderCombobox({ value: "/bin/zsh", synthesised: false, shells: [ZSH] });
    openPopover();
    const input = screen.getByRole("textbox", { name: "Add a shell by path" });
    fireEvent.change(input, { target: { value: "relative/path" } });
    await screen.findByText("an absolute path is required");
  });
});
