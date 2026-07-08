import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";

interface GateTestState {
  activeHostId: string | null;
  reachability: {
    status: "checking" | "reachable" | "unreachable";
    hostLabel: string;
  };
  readFile: {
    data:
      | {
          content: string;
          error: string | null;
          truncated: boolean;
        }
      | undefined;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
  };
}

const state = vi.hoisted((): GateTestState => ({
  activeHostId: "host-A",
  reachability: {
    status: "reachable",
    hostLabel: "Host A",
  },
  readFile: {
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
  },
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => state.activeHostId,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => state.reachability,
}));

vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => state.readFile,
}));

vi.mock("@/markdown/shiki-highlighter", () => ({
  useShikiHighlighter: () => ({ highlighter: null, theme: "dark" }),
  highlightCode: () => null,
}));

import { WorkspaceFileTile } from "../workspace-file-tile";
import { TabHostProvider } from "../../tab-host-provider";

const NODE = {
  id: "workspace-file:host-A:/work/repo:src/index.ts",
  instanceId: "inst-file-index",
  type: "workspace-file" as const,
  name: "index.ts",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "src/index.ts",
};

const MARKDOWN_NODE = {
  id: "workspace-file:host-A:/work/repo:CONTACT.md",
  instanceId: "inst-file-contact",
  type: "workspace-file" as const,
  name: "CONTACT.md",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "CONTACT.md",
};

const MARKDOWN_LONG_EXTENSION_NODE = {
  id: "workspace-file:host-A:/work/repo:README.markdown",
  instanceId: "inst-file-readme",
  type: "workspace-file" as const,
  name: "README.markdown",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "README.markdown",
};

function renderTile(boundHostId: string, node: WorkspaceFileRef): void {
  render(
    <TabHostProvider hostId={boundHostId}>
      <WorkspaceFileTile node={node} viewTabId="tab-1" isActive />
    </TabHostProvider>,
  );
}

describe("<WorkspaceFileTile /> host-binding gate", () => {
  beforeEach(() => {
    state.activeHostId = "host-A";
    state.reachability = { status: "reachable", hostLabel: "Host A" };
    state.readFile = {
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    };
  });
  afterEach(cleanup);

  it("shows the offline banner when the bound host is unreachable", () => {
    state.reachability = { status: "unreachable", hostLabel: "Host A" };
    renderTile("host-A", NODE);
    expect(screen.getByText(/currently unreachable/)).toBeTruthy();
  });

  it("shows the inactive banner when the bound host is not the active host", () => {
    state.activeHostId = "host-B";
    renderTile("host-A", NODE);
    expect(
      screen.getByText(/Switch your active host to "Host A"/),
    ).toBeTruthy();
  });

  it("shows the inactive banner when there is no active host", () => {
    state.activeHostId = null;
    renderTile("host-A", NODE);
    expect(screen.getByText(/Switch your active host/)).toBeTruthy();
  });

  it("renders the live preview when the bound host is the active, reachable host", () => {
    renderTile("host-A", NODE);
    // Live body mounts; the read query is mocked into its loading state, so
    // no host-binding banner is shown.
    expect(screen.queryByText(/Switch your active host/)).toBeNull();
    expect(screen.queryByText(/currently unreachable/)).toBeNull();
    expect(screen.getByText("src/index.ts")).toBeTruthy();
  });

  it("shows markdown source and preview modes for markdown files", () => {
    state.readFile = {
      data: {
        content: "# Contact Information\n\nReach us any time.",
        error: null,
        truncated: false,
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    renderTile("host-A", MARKDOWN_NODE);

    const markdownButton = screen.getByRole("button", { name: "Markdown" });
    const previewButton = screen.getByRole("button", { name: "Preview" });
    expect(markdownButton.getAttribute("aria-pressed")).toBe("true");
    expect(previewButton.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByText((_content, element) => {
        return (
          element?.tagName === "CODE" &&
          element.textContent === "# Contact Information\n\nReach us any time."
        );
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Contact Information" }),
    ).toBeNull();

    fireEvent.click(previewButton);

    expect(screen.getByLabelText("CONTACT.md markdown preview")).toBeTruthy();
    expect(markdownButton.getAttribute("aria-pressed")).toBe("false");
    expect(previewButton.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("heading", { name: "Contact Information" }),
    ).toBeTruthy();

    fireEvent.click(markdownButton);

    expect(markdownButton.getAttribute("aria-pressed")).toBe("true");
    expect(previewButton.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.queryByRole("heading", { name: "Contact Information" }),
    ).toBeNull();
  });

  it("shows markdown view modes for .markdown files", () => {
    state.readFile = {
      data: {
        content: "# Readme",
        error: null,
        truncated: false,
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    renderTile("host-A", MARKDOWN_LONG_EXTENSION_NODE);

    expect(screen.getByRole("button", { name: "Markdown" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
  });

  it("disables markdown preview for large markdown files", () => {
    state.readFile = {
      data: {
        content: "# Large\n\n" + "content ".repeat(15_000),
        error: null,
        truncated: false,
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    renderTile("host-A", MARKDOWN_NODE);

    const markdownButton = screen.getByRole("button", { name: "Markdown" });
    const previewButton = screen.getByRole("button", { name: "Preview" });
    expect(markdownButton.getAttribute("aria-pressed")).toBe("true");
    expect(previewButton.getAttribute("disabled")).toBe("");

    fireEvent.click(previewButton);

    expect(markdownButton.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByLabelText("CONTACT.md markdown preview")).toBeNull();
  });

  it("does not show markdown view modes for non-markdown files", () => {
    state.readFile = {
      data: {
        content: "export const value = 1;",
        error: null,
        truncated: false,
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    renderTile("host-A", NODE);

    expect(screen.queryByRole("button", { name: "Markdown" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });
});
