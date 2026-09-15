import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { DesktopMenuBar } from "@/components/layout/header/desktop-menu-bar";
import type {
  DesktopMenuCommandPayload,
  DesktopTopLevelMenuId,
} from "@/lib/windows/types";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

type DesktopPlatform = "darwin" | "win32" | "linux";

interface UserActions {
  click(target: Element): Promise<void>;
  hover(target: Element): Promise<void>;
}

interface MenuEntry {
  readonly id: string;
  readonly type: "normal" | "separator" | "checkbox" | "radio" | "submenu";
  readonly label: string;
  readonly enabled: boolean;
  readonly checked: boolean;
  readonly accelerator: string | null;
  readonly children: readonly MenuEntry[];
}

interface MenuSnapshot {
  readonly revision: number;
  readonly menus: readonly {
    readonly id: DesktopTopLevelMenuId;
    readonly label: string;
    readonly items: readonly MenuEntry[];
  }[];
}

function entry(
  id: string,
  type: MenuEntry["type"],
  label: string,
  options: {
    readonly enabled: boolean;
    readonly checked: boolean;
    readonly children: readonly MenuEntry[];
  },
): MenuEntry {
  return {
    id,
    type,
    label,
    enabled: options.enabled,
    checked: options.checked,
    accelerator: null,
    children: options.children,
  };
}

function createSnapshot(revision: number): MenuSnapshot {
  return {
    revision,
    menus: [
      {
        id: "file",
        label: "File",
        items: [
          entry("file.new", "normal", "New File", {
            enabled: true,
            checked: false,
            children: [],
          }),
          entry("file.disabled", "normal", "Disabled File", {
            enabled: false,
            checked: false,
            children: [],
          }),
          entry("file.separator", "separator", "", {
            enabled: true,
            checked: false,
            children: [],
          }),
          entry("file.toggle", "checkbox", "Show Welcome", {
            enabled: true,
            checked: true,
            children: [],
          }),
          entry("file.more", "submenu", "More", {
            enabled: true,
            checked: false,
            children: [
              entry("file.more.child", "normal", "Nested Action", {
                enabled: true,
                checked: false,
                children: [],
              }),
            ],
          }),
        ],
      },
      {
        id: "edit",
        label: "Edit",
        items: [
          entry("edit.copy", "normal", "Copy", {
            enabled: true,
            checked: false,
            children: [],
          }),
        ],
      },
      { id: "view", label: "View", items: [] },
      { id: "window", label: "Window", items: [] },
      { id: "help", label: "Help", items: [] },
    ],
  };
}

function buildHost(platform: DesktopPlatform) {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const snapshot = createSnapshot(17);
  const openTopLevel = vi.fn(() => Promise.resolve());
  const getSnapshot = vi.fn(() => Promise.resolve(snapshot));
  const executeItem = vi.fn(() => Promise.resolve());
  Object.assign(host, {
    menu: {
      platform,
      onCommand: (_handler: (payload: DesktopMenuCommandPayload) => void) => ({
        dispose: () => undefined,
      }),
      getSnapshot,
      executeItem,
      openTopLevel,
    },
  });
  return { host, openTopLevel, getSnapshot, executeItem };
}

function renderMenuBar(host: IRunnerHost): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RunnerHostProvider runnerHost={host}>
        <DesktopMenuBar />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function applicationMenubar(): HTMLElement {
  return screen.getByRole("menubar", { name: "Application menu" });
}

async function openMenu(
  user: UserActions,
  label: string,
): Promise<HTMLElement> {
  const trigger = within(applicationMenubar()).getByRole("menuitem", {
    name: label,
  });
  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  await within(menu).findByRole("menuitem", { name: "New File" });
  return menu;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

for (const platform of ["win32", "linux"] as const) {
  describe(`<DesktopMenuBar /> on ${platform}`, () => {
    it("renders the snapshot labels and menu item state", async () => {
      const fixture = buildHost(platform);
      renderMenuBar(fixture.host);

      const menubar = applicationMenubar();
      expect(
        within(menubar)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["File", "Edit", "View", "Window", "Help"]);

      const menu = await openMenu(userEvent.setup(), "File");
      expect(
        within(menu).getByRole("menuitem", { name: "New File" }),
      ).not.toBeNull();
      expect(
        within(menu)
          .getByRole("menuitemcheckbox", { name: "Show Welcome" })
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(within(menu).getByRole("separator")).not.toBeNull();
      expect(
        within(menu)
          .getByRole("menuitem", { name: "More" })
          .getAttribute("aria-haspopup"),
      ).toBe("menu");
    });

    it("does not open a menu from idle hover", async () => {
      const fixture = buildHost(platform);
      renderMenuBar(fixture.host);
      const user = userEvent.setup();
      const edit = within(applicationMenubar()).getByRole("menuitem", {
        name: "Edit",
      });

      await user.hover(edit);

      expect(screen.queryByRole("menu")).toBeNull();
      expect(edit.getAttribute("aria-expanded")).toBe("false");
    });

    it("opens on click and switches to an adjacent menu by hover", async () => {
      const fixture = buildHost(platform);
      renderMenuBar(fixture.host);
      const user = userEvent.setup();
      await openMenu(user, "File");

      const edit = within(applicationMenubar()).getByRole("menuitem", {
        name: "Edit",
      });
      await user.hover(edit);

      await waitFor(() => {
        expect(screen.getByRole("menu").textContent).toContain("Copy");
      });
      expect(screen.queryByText("New File")).toBeNull();
    });

    it("starts a session from an Alt mnemonic", async () => {
      const fixture = buildHost(platform);
      renderMenuBar(fixture.host);

      fireEvent.keyDown(document.body, { key: "f", altKey: true });

      const menu = await screen.findByRole("menu");
      await within(menu).findByRole("menuitem", { name: "New File" });
      expect(within(menu).getByText("New File")).not.toBeNull();
    });

    it("ends the session on Escape and requires a new click before hover reopens it", async () => {
      const fixture = buildHost(platform);
      renderMenuBar(fixture.host);
      const user = userEvent.setup();
      const menu = await openMenu(user, "File");
      fireEvent.keyDown(menu, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();

      const edit = within(applicationMenubar()).getByRole("menuitem", {
        name: "Edit",
      });
      await user.hover(edit);
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("ends on outside pointer, blur, and action completion", async () => {
      const fixture = buildHost(platform);
      renderMenuBar(fixture.host);
      const user = userEvent.setup();
      await openMenu(user, "File");
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("menu")).toBeNull();

      await openMenu(user, "File");
      act(() => {
        fireEvent.blur(window);
      });
      await waitFor(() => {
        expect(screen.queryByRole("menu")).toBeNull();
      });

      const menu = await openMenu(user, "File");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "New File" }));
      await waitFor(() => {
        expect(fixture.executeItem).toHaveBeenCalledOnce();
      });
      expect(fixture.executeItem).toHaveBeenCalledWith(17, "file.new");
    });

    it("executes an enabled action once, preserves the original focus, and ignores disabled items", async () => {
      const fixture = buildHost(platform);
      const user = userEvent.setup();
      render(
        <QueryClientProvider client={new QueryClient()}>
          <RunnerHostProvider runnerHost={fixture.host}>
            <input aria-label="Editor" />
            <DesktopMenuBar />
          </RunnerHostProvider>
        </QueryClientProvider>,
      );
      const editor = screen.getByRole("textbox", { name: "Editor" });
      editor.focus();
      const menu = await openMenu(user, "File");
      fireEvent.click(
        within(menu).getByRole("menuitem", { name: "Disabled File" }),
      );
      expect(fixture.executeItem).not.toHaveBeenCalled();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "New File" }));

      await waitFor(() => {
        expect(fixture.executeItem).toHaveBeenCalledOnce();
      });
      expect(fixture.executeItem).toHaveBeenCalledWith(17, "file.new");
      expect(document.activeElement).toBe(editor);
    });
  });
}

describe("<DesktopMenuBar /> platform gating", () => {
  it("stays absent for macOS and browser hosts", () => {
    const macHost = buildHost("darwin");
    render(
      <RunnerHostProvider runnerHost={macHost.host}>
        <DesktopMenuBar />
      </RunnerHostProvider>,
    );
    expect(
      screen.queryByRole("navigation", { name: "Application menu" }),
    ).toBeNull();

    cleanup();
    render(<DesktopMenuBar />);
    expect(
      screen.queryByRole("navigation", { name: "Application menu" }),
    ).toBeNull();
  });
});
