import { useState, type ComponentProps } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRecentEntry } from "@traycer/protocol/host/workspace/unary-schemas";
import { RecentWorkspacesSection } from "../recent-workspaces-section";

const RECENTS: readonly WorkspaceRecentEntry[] = [
  { path: "/projects/alpha", lastOpenedAt: "2026-08-18T00:00:00.000Z" },
  { path: "/projects/beta", lastOpenedAt: "2026-08-17T00:00:00.000Z" },
];
const BASE_PROPS = {
  entries: RECENTS,
  activeCount: 0,
  pendingPath: null,
  failedPaths: new Set<string>(),
  onAdd: () => Promise.resolve(true),
  onLocate: () => Promise.resolve(true),
  onForget: () => Promise.resolve(true),
} satisfies ComponentProps<typeof RecentWorkspacesSection>;

afterEach(cleanup);

describe("RecentWorkspacesSection", () => {
  it("stays hidden when there are no active or recent folders", () => {
    render(
      <RecentWorkspacesSection {...BASE_PROPS} entries={[]} activeCount={0} />,
    );

    expect(
      screen.queryByRole("button", { name: "Recent folders, 0" }),
    ).toBeNull();
  });

  it("keeps an explained disabled disclosure when there are no recent folders", async () => {
    render(
      <RecentWorkspacesSection {...BASE_PROPS} entries={[]} activeCount={1} />,
    );

    const disclosure = screen.getByRole("button", {
      name: "Recent folders, 0",
    });
    expect(disclosure.getAttribute("aria-disabled")).toBe("true");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");

    fireEvent.focus(disclosure);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "No recent folders",
    );
  });

  it("stays collapsed behind a counted disclosure when context is active", () => {
    render(<RecentWorkspacesSection {...BASE_PROPS} activeCount={1} />);

    const disclosure = screen.getByRole("button", {
      name: "Recent folders, 2",
    });
    expect(disclosure.className).toContain("ms-auto");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("alpha")).toBeNull();

    fireEvent.click(disclosure);
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("/projects/alpha")).toBeTruthy();
  });

  it("opens automatically when no workspace is active", () => {
    render(<RecentWorkspacesSection {...BASE_PROPS} />);

    expect(screen.getByText("alpha")).toBeTruthy();
    const disclosure = screen.getByRole("button", {
      name: "Recent folders, 2",
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("keeps stale-path recovery inline and disables parallel Adds", () => {
    render(
      <RecentWorkspacesSection
        {...BASE_PROPS}
        pendingPath="/projects/beta"
        failedPaths={new Set(["/projects/alpha"])}
        onAdd={() => Promise.resolve(false)}
      />,
    );

    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Retry alpha" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Locate alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Forget alpha" })).toBeTruthy();
  });

  it("moves focus to the next Add after a successful row action", async () => {
    const add = vi.fn((_path: string) => Promise.resolve(true));

    function Harness() {
      const [entries, setEntries] = useState(RECENTS);
      return (
        <RecentWorkspacesSection
          {...BASE_PROPS}
          entries={entries}
          onAdd={async (path) => {
            const added = await add(path);
            setEntries((current) =>
              current.filter((entry) => entry.path !== path),
            );
            return added;
          }}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Add alpha to context" }),
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Add beta to context" }),
      );
    });
  });
});
