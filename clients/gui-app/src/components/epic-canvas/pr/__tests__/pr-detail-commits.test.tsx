import { describe, it, expect, afterEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  PrCommit,
  PrCommitsSection,
  PrDetailCore,
} from "@traycer/protocol/host/pr-schemas";
import { PrDetailCommits } from "@/components/epic-canvas/pr/pr-detail-commits";

const writeText = vi.hoisted(() =>
  vi.fn((_value: string) => Promise.resolve()),
);

vi.stubGlobal("navigator", {
  ...globalThis.navigator,
  clipboard: { writeText },
});

function core(): PrDetailCore {
  return {
    observedAt: 1_000,
    githubHost: "github.com",
    base: { owner: "acme", repo: "widgets", prNumber: 7 },
    prUrl: "https://github.com/acme/widgets/pull/7",
    state: "open",
    isDraft: false,
    title: "Add the cap",
    body: "",
    author: null,
    baseRefName: "main",
    headRefName: "feature/cap",
    headRefOid: "a".repeat(40),
    additions: 10,
    deletions: 2,
    checksRollup: null,
    reviewDecision: null,
    reviewRequests: [],
    commentCount: 0,
    updatedAt: 1_000,
    mergedAt: null,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    repoRole: "superproject",
    linkGroupKey: "/tmp/w",
    owners: [],
  };
}

const FULL_OID = "e346a92c1d4f5b6a7890123456789abcdef01234";

function commit(overrides: Partial<PrCommit>): PrCommit {
  return {
    oid: FULL_OID,
    messageHeadline: "Update traycer submodule",
    author: { login: "hdkshingala", avatarUrl: null },
    authorName: "Hardik",
    committedAt: 1_000,
    ...overrides,
  };
}

function section(commits: readonly PrCommit[]): PrCommitsSection {
  return {
    observedAt: 1_000,
    commits: [...commits],
    totalCount: commits.length,
    isTruncated: false,
  };
}

function renderCommits(onOpenCommit: (url: string) => void): void {
  render(
    <PrDetailCommits
      core={core()}
      commits={section([commit({})])}
      onOpenCommit={onOpenCommit}
    />,
  );
}

afterEach(() => {
  cleanup();
  writeText.mockClear();
});

describe("PrDetailCommits", () => {
  it("copies the FULL sha while showing the short one", async () => {
    // The short form is what a reader recognizes; the full form is what
    // `git show` wants. Abbreviating on the clipboard would make the button
    // quietly useless for the thing it exists for.
    renderCommits(() => undefined);

    const chip = screen.getByTestId("pr-detail-commit-copy-sha");
    expect(chip.textContent).toContain("e346a92");
    fireEvent.click(chip);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(FULL_OID);
    });
  });

  it("does not open GitHub when the sha is copied", async () => {
    // The chip used to be a second route to where the row already goes.
    const opened: string[] = [];
    renderCommits((url) => opened.push(url));

    fireEvent.click(screen.getByTestId("pr-detail-commit-copy-sha"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(opened).toEqual([]);
  });

  it("keeps the row itself opening the commit on GitHub", () => {
    const opened: string[] = [];
    renderCommits((url) => opened.push(url));

    fireEvent.click(screen.getByLabelText(/Open commit e346a92 on GitHub/u));
    expect(opened).toEqual([
      `https://github.com/acme/widgets/pull/7/commits/${FULL_OID}`,
    ]);
  });

  it("confirms the copy so the click is not silent", async () => {
    renderCommits(() => undefined);

    const chip = screen.getByTestId("pr-detail-commit-copy-sha");
    expect(chip.getAttribute("data-copied")).toBe("false");
    fireEvent.click(chip);
    await waitFor(() => {
      expect(chip.getAttribute("data-copied")).toBe("true");
    });
    expect(chip.getAttribute("aria-label")).toBe("Copied");
  });

  it("still offers the copy button when the PR has no url to open", () => {
    // No `prUrl` means the row cannot open anything - but the sha is still
    // right there and still worth copying.
    render(
      <PrDetailCommits
        core={{ ...core(), prUrl: null }}
        commits={section([commit({})])}
        onOpenCommit={() => undefined}
      />,
    );
    expect(screen.getByTestId("pr-detail-commit-copy-sha")).toBeTruthy();
  });
});
