import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ChatRowWorktreeMetadata } from "@/hooks/worktree/use-epic-chat-worktree-metadata";
import type {
  WorktreeDisplayedPrState,
  WorktreePrReference,
} from "@/components/worktree/worktree-pr-metadata-model";
import { ChatRowSecondLine } from "@/components/epic-canvas/sidebar/chat-row-second-line";
import { ChatRowWorktreeMetadataContext } from "@/components/epic-canvas/sidebar/chat-row-worktree-metadata-context";
import { RunnerHostContext } from "@/providers/runner-host-context";

const NODE_ID = "chat-node-1";
const EPIC_ID = "epic-1";

afterEach(() => {
  cleanup();
});

describe("ChatRowSecondLine", () => {
  it("renders a branch label", () => {
    renderSecondLine(
      metadata({
        label: "feature/branch-label",
        extraCount: 0,
        prReferences: [],
      }),
    );
    expect(screen.getByTestId("chat-row-workspace-label").textContent).toBe(
      "feature/branch-label",
    );
    expect(screen.queryByTestId("chat-row-workspace-extra-count")).toBeNull();
  });

  it("renders a folder-name label for a local binding with no branch", () => {
    renderSecondLine(
      metadata({
        label: "my-checkout",
        extraCount: 0,
        prReferences: [],
      }),
    );
    expect(screen.getByTestId("chat-row-workspace-label").textContent).toBe(
      "my-checkout",
    );
  });

  it("renders the +N extra-count badge", () => {
    renderSecondLine(
      metadata({
        label: "main",
        extraCount: 3,
        prReferences: [],
      }),
    );
    expect(
      screen.getByTestId("chat-row-workspace-extra-count").textContent,
    ).toBe("+3");
  });

  it("renders one icon per PR with data-pr-state for open/merged/closed", () => {
    renderSecondLine(
      metadata({
        label: "main",
        extraCount: 0,
        prReferences: [
          prReference({
            prNumber: 11,
            state: "open",
            url: "https://github.com/acme/app/pull/11",
          }),
          prReference({
            prNumber: 22,
            state: "merged",
            url: "https://github.com/acme/app/pull/22",
          }),
          prReference({
            prNumber: 33,
            state: "closed",
            url: "https://github.com/acme/app/pull/33",
          }),
        ],
      }),
    );
    const icons = screen.getAllByTestId("worktree-pr-state-icon");
    expect(icons).toHaveLength(3);
    expect(icons[0]?.getAttribute("data-pr-state")).toBe("open");
    expect(icons[1]?.getAttribute("data-pr-state")).toBe("merged");
    expect(icons[2]?.getAttribute("data-pr-state")).toBe("closed");
    expect(icons[0]?.textContent).toContain("#11");
    expect(icons[1]?.textContent).toContain("#22");
    expect(icons[2]?.textContent).toContain("#33");
  });

  it("opens the PR URL on click without activating the enclosing row", async () => {
    const user = userEvent.setup();
    const rowActivate = vi.fn();
    const host = createRunnerHost();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RunnerHostContext.Provider value={host}>
          <ChatRowWorktreeMetadataContext.Provider
            value={
              new Map([
                [
                  NODE_ID,
                  metadata({
                    label: "main",
                    extraCount: 0,
                    prReferences: [
                      prReference({
                        prNumber: 42,
                        state: "open",
                        url: "https://github.com/acme/app/pull/42",
                      }),
                    ],
                  }),
                ],
              ])
            }
          >
            <button type="button" onClick={rowActivate}>
              <ChatRowSecondLine
                epicId={EPIC_ID}
                nodeId={NODE_ID}
                artifactType="chat"
              />
            </button>
          </ChatRowWorktreeMetadataContext.Provider>
        </RunnerHostContext.Provider>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("link", { name: "Open PR #42 Open" }));

    expect(host.openedExternalLinks).toEqual([
      "https://github.com/acme/app/pull/42",
    ]);
    expect(rowActivate).not.toHaveBeenCalled();
  });

  it("opens the PR URL on Enter and Space without activating the enclosing row", async () => {
    const user = userEvent.setup();
    const rowActivate = vi.fn();
    const host = createRunnerHost();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RunnerHostContext.Provider value={host}>
          <ChatRowWorktreeMetadataContext.Provider
            value={
              new Map([
                [
                  NODE_ID,
                  metadata({
                    label: "main",
                    extraCount: 0,
                    prReferences: [
                      prReference({
                        prNumber: 7,
                        state: "merged",
                        url: "https://github.com/acme/app/pull/7",
                      }),
                    ],
                  }),
                ],
              ])
            }
          >
            <button type="button" onClick={rowActivate}>
              <ChatRowSecondLine
                epicId={EPIC_ID}
                nodeId={NODE_ID}
                artifactType="chat"
              />
            </button>
          </ChatRowWorktreeMetadataContext.Provider>
        </RunnerHostContext.Provider>
      </QueryClientProvider>,
    );

    const link = screen.getByRole("link", { name: "Open PR #7 Merged" });
    expect(link.getAttribute("tabindex")).toBe("0");
    expect(link.getAttribute("role")).toBe("link");

    link.focus();
    await user.keyboard("{Enter}");
    expect(host.openedExternalLinks).toEqual([
      "https://github.com/acme/app/pull/7",
    ]);
    expect(rowActivate).not.toHaveBeenCalled();

    host.openedExternalLinks.length = 0;
    link.focus();
    await user.keyboard(" ");
    expect(host.openedExternalLinks).toEqual([
      "https://github.com/acme/app/pull/7",
    ]);
    expect(rowActivate).not.toHaveBeenCalled();
  });

  it("renders nothing for an owner absent from the batch (single-line collapse)", () => {
    const { container } = renderSecondLine(null);
    expect(container.textContent).toBe("");
    expect(
      screen.queryByTestId(`epic-sidebar-row-workspace-${NODE_ID}`),
    ).toBeNull();
  });

  it("renders nothing for empty PR references (prState none / unprobed produce no icons)", () => {
    // worktreePrReferences already drops prState "none" and null (unprobed).
    // Row-2 still shows the workspace line when label/extra exist, but no PR icons.
    renderSecondLine(
      metadata({
        label: "main",
        extraCount: 0,
        prReferences: [],
      }),
    );
    expect(screen.getByTestId("chat-row-workspace-label")).not.toBeNull();
    expect(screen.queryByTestId("chat-row-pr-icons")).toBeNull();
    expect(screen.queryByTestId("worktree-pr-state-icon")).toBeNull();
  });
});

function metadata(value: ChatRowWorktreeMetadata): ChatRowWorktreeMetadata {
  return value;
}

const PR_STATE_LABEL: Record<WorktreeDisplayedPrState, string> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
};

function prReference(
  overrides: Partial<WorktreePrReference> & {
    readonly prNumber: number;
    readonly state: WorktreeDisplayedPrState;
    readonly url: string;
  },
): WorktreePrReference {
  const stateLabel = PR_STATE_LABEL[overrides.state];
  return {
    key: `worktree:${String(overrides.prNumber)}:${overrides.url}`,
    label: `#${String(overrides.prNumber)} ${stateLabel}`,
    ariaLabel: `Open PR #${String(overrides.prNumber)} ${stateLabel}`,
    state: overrides.state,
    prNumber: overrides.prNumber,
    url: overrides.url,
    branch: overrides.branch ?? "main",
    worktreePath: overrides.worktreePath ?? "/wt/app",
  };
}

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.test/sign-in",
    authnBaseUrl: "https://auth.traycer.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function renderSecondLine(value: ChatRowWorktreeMetadata | null): RenderResult {
  const map =
    value === null
      ? new Map<string, ChatRowWorktreeMetadata>()
      : new Map([[NODE_ID, value]]);
  const host = createRunnerHost();
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RunnerHostContext.Provider value={host}>
        <ChatRowWorktreeMetadataContext.Provider value={map}>
          <ChatRowSecondLine
            epicId={EPIC_ID}
            nodeId={NODE_ID}
            artifactType="chat"
          />
        </ChatRowWorktreeMetadataContext.Provider>
      </RunnerHostContext.Provider>
    </QueryClientProvider>,
  );
}
