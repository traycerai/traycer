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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoBranchPrefixState } from "@traycer/protocol/host/worktree-schemas";
import { resolveEffectiveBranchPrefix } from "@/lib/worktree/effective-branch-prefix";
import {
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  useSettingsStore,
} from "@/stores/settings/settings-store";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn<
    (
      variables: {
        readonly epicId: string;
        readonly workspacePath: string;
        readonly branchPrefix: string | null;
      },
      options: { readonly onSuccess: (data: { updated: boolean }) => void },
    ) => void
  >(),
  supportsMethod: { current: true },
  isPending: { current: false },
  // Controls the mutation's simulated RPC response - `false` reproduces the
  // host's non-git / vanished-checkout no-op (`{ updated: false }`), which
  // must NOT be treated as a persisted save.
  updated: { current: true },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => mocks.supportsMethod.current,
}));

vi.mock(
  "@/hooks/worktree/use-worktree-set-repo-branch-prefix-mutation",
  () => ({
    useWorktreeSetRepoBranchPrefixFor: () => ({
      mutate: (
        variables: {
          readonly epicId: string;
          readonly workspacePath: string;
          readonly branchPrefix: string | null;
        },
        options: { readonly onSuccess: (data: { updated: boolean }) => void },
      ) => {
        mocks.mutate(variables, options);
        options.onSuccess({ updated: mocks.updated.current });
      },
      isPending: mocks.isPending.current,
    }),
  }),
);

// Stable illustrative suffix so effective-branch assertions stay deterministic
// (the production component picks a fresh friendly name per mount).
vi.mock("@/lib/worktree/random-friendly-name", () => ({
  pickFriendlyBranchSuffix: () => "soft-wombat",
}));

import { RepoBranchPrefixSection } from "@/components/home/worktree/repo-branch-prefix-section";

const WORKSPACE = "/tmp/repo";
const REPO_ID = { owner: "anur4ag", repo: "tailmark" };
const PREVIEW_SUFFIX = "soft-wombat";

/**
 * Local composition stand-in for the production `composeCandidateBranch`
 * path: resolves the effective prefix (so invalid present values fall back
 * the same way bulk generation does), then single-repo = prefix+suffix or
 * multi-repo inserts a fixed slug. Dialog-level multi-repo coverage lives in
 * `worktree-scripts-dialog.test.tsx`.
 */
function makeComposeCandidateBranch(options: {
  readonly multiRepoSlug: string | null;
  readonly workspacePath: string;
}): (prefixState: RepoBranchPrefixState, suffix: string) => string | null {
  return (prefixState, suffix) => {
    const globalPrefix = useSettingsStore.getState().worktreeBranchPrefix;
    const resolved = resolveEffectiveBranchPrefix(
      prefixState,
      globalPrefix,
      options.workspacePath,
    );
    if (options.multiRepoSlug !== null) {
      return `${resolved.value}${options.multiRepoSlug}-${suffix}`;
    }
    return `${resolved.value}${suffix}`;
  };
}

type RenderOptions = {
  readonly repoIdentifier: {
    readonly owner: string;
    readonly repo: string;
  } | null;
  readonly workspacePath: string;
  readonly currentProposedBranchName: string | null;
  // Non-null while the dialog's post-save regeneration offer is up: must win
  // over `currentProposedBranchName` so Effective branch matches what the
  // offer would stage (item 5 of the layered-settings review findings).
  readonly activeRegenerateCandidate: string | null;
  readonly multiRepoSlug: string | null;
  readonly onEditingCancelAvailable: (cancel: (() => void) | null) => void;
};

function renderSection(
  repoBranchPrefixState: RepoBranchPrefixState,
  onSaved: (
    state: RepoBranchPrefixState,
    candidateBranchName: string | null,
  ) => void,
  options: Partial<RenderOptions> | null,
) {
  // Explicit null for repoIdentifier must win over the default (?? would not).
  const workspacePath = options?.workspacePath ?? WORKSPACE;
  const repoIdentifier =
    options !== null &&
    Object.prototype.hasOwnProperty.call(options, "repoIdentifier")
      ? (options.repoIdentifier ?? null)
      : REPO_ID;
  const currentProposedBranchName = options?.currentProposedBranchName ?? null;
  const activeRegenerateCandidate = options?.activeRegenerateCandidate ?? null;
  const multiRepoSlug = options?.multiRepoSlug ?? null;
  const onEditingCancelAvailable =
    options?.onEditingCancelAvailable ?? ((): void => undefined);

  return render(
    <RepoBranchPrefixSection
      workspacePath={workspacePath}
      repoIdentifier={repoIdentifier}
      repoBranchPrefixState={repoBranchPrefixState}
      epicId="epic-1"
      hostClient={null}
      currentProposedBranchName={currentProposedBranchName}
      activeRegenerateCandidate={activeRegenerateCandidate}
      composeCandidateBranch={makeComposeCandidateBranch({
        multiRepoSlug,
        workspacePath,
      })}
      onEditingCancelAvailable={onEditingCancelAvailable}
      onSaved={onSaved}
    />,
  );
}

const noop = (): void => undefined;

function prefixInput(): HTMLInputElement {
  const field = screen.getByLabelText("Prefix");
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("expected the repository prefix input");
  }
  return field;
}

function applyButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: "Save prefix" });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("expected Apply override button");
  }
  return button;
}

function chooseOverride(): void {
  fireEvent.click(screen.getByTestId("repo-branch-prefix-choice-override"));
}

function effectiveBranchValue(): string {
  const label = screen.getByText(
    /^(Example|Staged branch|Current example|Current staged)$/,
  );
  const row = label.closest("div");
  if (row === null) {
    throw new Error("expected effective branch row");
  }
  const code = row.querySelector("code");
  if (code === null) {
    throw new Error("expected effective branch code value");
  }
  return code.textContent;
}

describe("<RepoBranchPrefixSection />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useSettingsStore.setState({
      worktreeBranchPrefix: DEFAULT_WORKTREE_BRANCH_PREFIX,
    });
    mocks.mutate.mockReset();
    mocks.supportsMethod.current = true;
    mocks.isPending.current = false;
    mocks.updated.current = true;
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  describe("shell / identity", () => {
    it("renders the Branch naming shell with owner/repo identity", () => {
      renderSection({ status: "absent" }, noop, null);
      const shell = screen.getByTestId("repo-branch-prefix-section");
      expect(within(shell).getByText("Branch prefix")).toBeTruthy();
      expect(
        within(shell).getByText("Repository · anur4ag/tailmark"),
      ).toBeTruthy();
    });

    it("falls back to the workspace folder name when repoIdentifier is null", () => {
      renderSection({ status: "absent" }, noop, {
        repoIdentifier: null,
        workspacePath: "/Users/me/my-project",
      });
      expect(screen.getByText("Repository · my-project")).toBeTruthy();
    });
  });

  describe("inherited state", () => {
    it("selects Use global default with the global value and effective branch", () => {
      renderSection({ status: "absent" }, noop, null);

      expect(
        screen.getByTestId("repo-branch-prefix-choice-global"),
      ).toBeTruthy();
      expect(
        screen.getByTestId("repo-branch-prefix-choice-override"),
      ).toBeTruthy();
      expect(screen.getByText("Global default")).toBeTruthy();
      expect(screen.getByText("This repository")).toBeTruthy();
      // Prefix appears both on the radio detail and in the preview split.
      expect(screen.getAllByText("traycer/").length).toBeGreaterThan(0);
      expect(screen.getByText("Example")).toBeTruthy();
      expect(effectiveBranchValue()).toBe(`traycer/${PREVIEW_SUFFIX}`);
      expect(screen.queryByLabelText("Prefix")).toBeNull();
      expect(screen.queryByRole("button", { name: "Save prefix" })).toBeNull();
      expect(
        screen.getByRole("radiogroup", { name: "Branch prefix source" }),
      ).toBeTruthy();
    });

    it("enters editing when Override for this repository is chosen", () => {
      renderSection({ status: "absent" }, noop, null);
      chooseOverride();

      expect(prefixInput()).toBeTruthy();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      expect(applyButton()).toBeTruthy();
      // Fresh entry focuses the prefix input (mount effect, not autoFocus).
      expect(document.activeElement).toBe(prefixInput());
    });

    it("lets the picker's real staged proposal win over the composed candidate", () => {
      renderSection({ status: "absent" }, noop, {
        currentProposedBranchName: "traycer/swift-otter",
      });

      expect(effectiveBranchValue()).toBe("traycer/swift-otter");
      expect(screen.queryByText(`traycer/${PREVIEW_SUFFIX}`)).toBeNull();
    });

    it("uses multi-repo composition for the illustrative effective branch", () => {
      renderSection({ status: "absent" }, noop, {
        multiRepoSlug: "tailmark",
      });

      expect(effectiveBranchValue()).toBe(`traycer/tailmark-${PREVIEW_SUFFIX}`);
    });
  });

  describe("editing state", () => {
    it("shows live effective-branch preview and global fallback while drafting", () => {
      renderSection({ status: "absent" }, noop, null);
      chooseOverride();
      fireEvent.change(prefixInput(), { target: { value: "anurag/" } });

      expect(screen.getByText("Example")).toBeTruthy();
      expect(effectiveBranchValue()).toBe(`anurag/${PREVIEW_SUFFIX}`);
      // Radio title + "Global default · …" line both match.
      expect(screen.getAllByText(/Global default/).length).toBeGreaterThan(0);
      expect(
        screen.getByTestId("repo-branch-prefix-choice-global"),
      ).toBeTruthy();
      expect(
        screen.getByTestId("repo-branch-prefix-choice-override"),
      ).toBeTruthy();
    });

    it("multi-repo live preview inserts the repo slug via composeCandidateBranch", () => {
      renderSection({ status: "absent" }, noop, {
        multiRepoSlug: "tailmark",
      });
      chooseOverride();
      fireEvent.change(prefixInput(), { target: { value: "team/" } });

      expect(effectiveBranchValue()).toBe(`team/tailmark-${PREVIEW_SUFFIX}`);
    });

    it("treats an empty prefix as a valid deliberate no-prefix override", () => {
      const onSaved = vi.fn();
      renderSection({ status: "absent" }, onSaved, null);
      chooseOverride();
      expect(prefixInput().value).toBe("");
      expect(applyButton().disabled).toBe(false);
      fireEvent.click(applyButton());

      expect(mocks.mutate).toHaveBeenCalledTimes(1);
      expect(mocks.mutate.mock.calls[0][0]).toEqual({
        epicId: "epic-1",
        workspacePath: WORKSPACE,
        branchPrefix: "",
      });
      expect(onSaved).toHaveBeenCalledWith(
        { status: "present", value: "" },
        PREVIEW_SUFFIX,
      );
      expect(screen.getByTestId("repo-branch-prefix-saved")).toBeTruthy();
      expect(screen.getByText("No prefix")).toBeTruthy();
    });

    it("blocks Apply on an invalid draft and shows Current effective branch from the saved result", () => {
      renderSection({ status: "absent" }, noop, null);
      chooseOverride();
      fireEvent.change(prefixInput(), { target: { value: "has spaces" } });

      expect(applyButton().disabled).toBe(true);
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(/spaces/i);
      expect(prefixInput().getAttribute("aria-invalid")).toBe("true");
      expect(prefixInput().getAttribute("aria-describedby")).toBe(
        alert.getAttribute("id"),
      );
      expect(screen.getByText("Current example")).toBeTruthy();
      expect(effectiveBranchValue()).toBe(`traycer/${PREVIEW_SUFFIX}`);
      expect(screen.queryByText(`has spaces/${PREVIEW_SUFFIX}`)).toBeNull();
      fireEvent.click(applyButton());
      expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it("applies a valid override and reports the new state plus the exact candidate via onSaved", () => {
      const onSaved = vi.fn();
      renderSection({ status: "absent" }, onSaved, null);
      chooseOverride();
      fireEvent.change(prefixInput(), { target: { value: "feat/" } });
      const shownWhileEditing = effectiveBranchValue();
      fireEvent.click(applyButton());

      expect(mocks.mutate).toHaveBeenCalledTimes(1);
      expect(mocks.mutate.mock.calls[0][0]).toEqual({
        epicId: "epic-1",
        workspacePath: WORKSPACE,
        branchPrefix: "feat/",
      });
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onSaved).toHaveBeenCalledWith(
        { status: "present", value: "feat/" },
        shownWhileEditing,
      );
      expect(shownWhileEditing).toBe(`feat/${PREVIEW_SUFFIX}`);
      expect(screen.getByTestId("repo-branch-prefix-saved")).toBeTruthy();
      // Saved summary + preview split both show the prefix.
      expect(screen.getAllByText("feat/").length).toBeGreaterThan(0);
    });

    it("cancels editing via Cancel and via choosing Use global default", () => {
      renderSection({ status: "absent" }, noop, null);
      chooseOverride();
      fireEvent.change(prefixInput(), { target: { value: "feat/" } });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByLabelText("Prefix")).toBeNull();
      expect(
        screen.getByTestId("repo-branch-prefix-choice-global"),
      ).toBeTruthy();

      chooseOverride();
      fireEvent.click(screen.getByTestId("repo-branch-prefix-choice-global"));
      expect(screen.queryByLabelText("Prefix")).toBeNull();
    });

    it("applies on Enter in the prefix input", () => {
      const onSaved = vi.fn();
      renderSection({ status: "absent" }, onSaved, null);
      chooseOverride();
      fireEvent.change(prefixInput(), { target: { value: "team/" } });
      fireEvent.keyDown(prefixInput(), { key: "Enter" });
      expect(mocks.mutate).toHaveBeenCalledTimes(1);
      expect(onSaved).toHaveBeenCalledWith(
        { status: "present", value: "team/" },
        `team/${PREVIEW_SUFFIX}`,
      );
    });

    it("registers cancelEditing with onEditingCancelAvailable only while editing", () => {
      const cancelRef: { current: (() => void) | null } = { current: null };
      renderSection({ status: "absent" }, noop, {
        onEditingCancelAvailable: (cancel) => {
          cancelRef.current = cancel;
        },
      });

      expect(cancelRef.current).toBeNull();
      chooseOverride();
      expect(typeof cancelRef.current).toBe("function");
      fireEvent.change(prefixInput(), { target: { value: "other/" } });
      const cancel = cancelRef.current;
      expect(cancel).not.toBeNull();
      act(() => {
        cancel?.();
      });
      expect(screen.queryByLabelText("Prefix")).toBeNull();
      expect(cancelRef.current).toBeNull();
      expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it("editing an existing saved override shows a static header (no choice rows)", () => {
      renderSection({ status: "present", value: "team/" }, noop, null);
      fireEvent.click(screen.getByRole("button", { name: "Edit prefix" }));

      expect(prefixInput().value).toBe("team/");
      expect(document.activeElement).toBe(prefixInput());
      expect(screen.getByText("This repository")).toBeTruthy();
      expect(
        screen.queryByTestId("repo-branch-prefix-choice-global"),
      ).toBeNull();
      expect(
        screen.queryByTestId("repo-branch-prefix-choice-override"),
      ).toBeNull();
    });
  });

  describe("saved override state", () => {
    it("shows the saved value, global fallback, effective branch, Edit and Remove", () => {
      renderSection({ status: "present", value: "anurag/" }, noop, null);

      expect(screen.getByTestId("repo-branch-prefix-saved")).toBeTruthy();
      expect(screen.getByText("This repository")).toBeTruthy();
      // Saved summary + preview split both show the prefix.
      expect(screen.getAllByText("anurag/").length).toBeGreaterThan(0);
      expect(effectiveBranchValue()).toBe(`anurag/${PREVIEW_SUFFIX}`);
      expect(screen.getAllByText(/Global default/).length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Edit prefix" })).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Remove prefix" }),
      ).toBeTruthy();
    });

    it("prefers currentProposedBranchName over composed candidate when no regenerate offer is active", () => {
      renderSection({ status: "present", value: "anurag/" }, noop, {
        currentProposedBranchName: "anurag/already-staged",
        activeRegenerateCandidate: null,
      });
      expect(effectiveBranchValue()).toBe("anurag/already-staged");
    });

    it("prefers activeRegenerateCandidate over currentProposedBranchName while the offer is active", () => {
      // While Keep/Use is up, Effective branch must show the captured candidate
      // the offer would stage - not the stale old staged proposal.
      renderSection({ status: "present", value: "team/" }, noop, {
        currentProposedBranchName: "traycer/swift-otter",
        activeRegenerateCandidate: "team/soft-wombat",
      });
      expect(effectiveBranchValue()).toBe("team/soft-wombat");
      expect(screen.queryByText("traycer/swift-otter")).toBeNull();
    });

    it("warns for a present value that fails client validation but still offers Edit", () => {
      renderSection({ status: "present", value: "has spaces" }, noop, null);

      expect(screen.getByTestId("repo-branch-prefix-saved")).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toMatch(
        /has spaces|invalid/i,
      );
      expect(screen.getByRole("button", { name: "Edit prefix" })).toBeTruthy();
      // Falls back to global for the effective branch while the stored value is bad.
      expect(effectiveBranchValue()).toBe(`traycer/${PREVIEW_SUFFIX}`);
    });
  });

  describe("remove confirmation", () => {
    it("cancels without mutating when the confirm dialog is dismissed", () => {
      const onSaved = vi.fn();
      renderSection({ status: "present", value: "team/" }, onSaved, null);

      fireEvent.click(screen.getByRole("button", { name: "Remove prefix" }));
      const dialog = screen.getByTestId("confirm-destructive-dialog");
      expect(dialog.textContent).toMatch(/Remove repository prefix/i);
      fireEvent.click(screen.getByTestId("confirm-cancel"));

      expect(mocks.mutate).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
      expect(screen.getByTestId("repo-branch-prefix-saved")).toBeTruthy();
    });

    it("removes the override on confirm and reports absent plus the candidate via onSaved", () => {
      const onSaved = vi.fn();
      renderSection({ status: "present", value: "team/" }, onSaved, null);

      fireEvent.click(screen.getByRole("button", { name: "Remove prefix" }));
      fireEvent.click(screen.getByTestId("confirm-action"));

      expect(mocks.mutate).toHaveBeenCalledTimes(1);
      expect(mocks.mutate.mock.calls[0][0]).toEqual({
        epicId: "epic-1",
        workspacePath: WORKSPACE,
        branchPrefix: null,
      });
      expect(onSaved).toHaveBeenCalledWith(
        { status: "absent" },
        `traycer/${PREVIEW_SUFFIX}`,
      );
      expect(
        screen.getByTestId("repo-branch-prefix-choice-global"),
      ).toBeTruthy();
      expect(screen.queryByTestId("repo-branch-prefix-saved")).toBeNull();
    });
  });

  describe("malformed state", () => {
    it("shows the repair warning only - no choice rows or edit affordance", () => {
      useSettingsStore.setState({ worktreeBranchPrefix: "global/" });
      renderSection({ status: "malformed" }, noop, null);

      const alert = screen.getByTestId("repo-branch-prefix-malformed");
      expect(alert.getAttribute("role")).toBe("alert");
      expect(alert.textContent).toMatch(/malformed|unreadable/i);
      expect(alert.textContent).toContain(
        `${WORKSPACE}/.traycer/environment.json`,
      );
      expect(screen.getByText("Example")).toBeTruthy();
      expect(effectiveBranchValue()).toBe(`global/${PREVIEW_SUFFIX}`);

      expect(
        screen.queryByTestId("repo-branch-prefix-choice-global"),
      ).toBeNull();
      expect(
        screen.queryByTestId("repo-branch-prefix-choice-override"),
      ).toBeNull();
      expect(screen.queryByLabelText("Prefix")).toBeNull();
      expect(screen.queryByRole("button", { name: "Edit prefix" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Remove prefix" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Save prefix" })).toBeNull();
      expect(screen.queryByText(/Show file location/i)).toBeNull();
    });

    it("still prefers currentProposedBranchName in malformed view", () => {
      renderSection({ status: "malformed" }, noop, {
        currentProposedBranchName: "staged/exact-name",
      });
      expect(effectiveBranchValue()).toBe("staged/exact-name");
    });
  });

  describe("unsupported host", () => {
    it("shows the global default and host callout with no edit path", () => {
      mocks.supportsMethod.current = false;
      renderSection({ status: "absent" }, noop, null);

      expect(screen.getByTestId("repo-branch-prefix-unsupported")).toBeTruthy();
      expect(screen.getByText(/require a newer Traycer host/i)).toBeTruthy();
      expect(screen.getByText("Global default")).toBeTruthy();
      expect(effectiveBranchValue()).toBe(`traycer/${PREVIEW_SUFFIX}`);
      expect(
        screen.queryByRole("radiogroup", { name: "Branch prefix source" }),
      ).toBeNull();
      expect(
        screen.queryByTestId("repo-branch-prefix-choice-override"),
      ).toBeNull();
      expect(screen.queryByLabelText("Prefix")).toBeNull();
      expect(screen.queryByRole("button", { name: "Save prefix" })).toBeNull();
    });

    it("still prefers currentProposedBranchName in unsupported view", () => {
      mocks.supportsMethod.current = false;
      renderSection({ status: "absent" }, noop, {
        currentProposedBranchName: "staged/from-picker",
      });
      expect(effectiveBranchValue()).toBe("staged/from-picker");
    });
  });

  describe("save feedback", () => {
    it("treats an updated:false response as a no-op, not a save", () => {
      mocks.updated.current = false;
      const onSaved = vi.fn();
      renderSection({ status: "absent" }, onSaved, null);

      chooseOverride();
      fireEvent.change(prefixInput(), { target: { value: "feat/" } });
      fireEvent.click(applyButton());

      expect(mocks.mutate).toHaveBeenCalledTimes(1);
      expect(onSaved).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toContain(
        "isn't a git repository",
      );
      expect(screen.getByLabelText("Prefix")).toBeTruthy();
    });
  });

  describe("focus restoration", () => {
    it("does not auto-focus the global radio on a cold Inherited open", () => {
      renderSection({ status: "absent" }, noop, null);
      const globalRadio = screen.getByRole("radio", {
        name: /Global default/i,
      });
      expect(document.activeElement).not.toBe(globalRadio);
    });

    it("does not auto-focus Edit override on a cold Saved open", () => {
      renderSection({ status: "present", value: "team/" }, noop, null);
      const edit = screen.getByRole("button", { name: "Edit prefix" });
      expect(document.activeElement).not.toBe(edit);
    });

    it("focuses Use global default after Cancel from a fresh (never-saved) edit", () => {
      renderSection({ status: "absent" }, noop, null);
      chooseOverride();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      const globalRadio = screen.getByRole("radio", {
        name: /Global default/i,
      });
      expect(document.activeElement).toBe(globalRadio);
    });

    it("focuses Edit override after Cancel from editing an existing saved override", () => {
      renderSection({ status: "present", value: "team/" }, noop, null);
      fireEvent.click(screen.getByRole("button", { name: "Edit prefix" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Edit prefix" }),
      );
    });

    it("focuses Edit override after a successful Apply", () => {
      renderSection({ status: "absent" }, noop, null);
      chooseOverride();
      fireEvent.change(prefixInput(), { target: { value: "feat/" } });
      fireEvent.click(applyButton());

      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Edit prefix" }),
      );
    });

    it("focuses Use global default after a successful confirmed Remove", () => {
      renderSection({ status: "present", value: "team/" }, noop, null);
      fireEvent.click(screen.getByRole("button", { name: "Remove prefix" }));
      fireEvent.click(screen.getByTestId("confirm-action"));

      const globalRadio = screen.getByRole("radio", {
        name: /Global default/i,
      });
      expect(document.activeElement).toBe(globalRadio);
    });
  });

  describe("radio keyboard navigation", () => {
    it("moves checked state between global and override with arrow keys", async () => {
      // user-event fires keyup immediately after keydown; Radix only auto-selects
      // the newly-focused radio while the arrow key is still considered pressed
      // (document keydown sets a flag, keyup clears it, and focus moves via
      // setTimeout). Drive keydown without keyup so the flag stays true through
      // the async focus move - then flush the timer.
      renderSection({ status: "absent" }, noop, null);

      const globalRadio = screen.getByRole("radio", {
        name: /Global default/i,
      });
      const overrideRadio = screen.getByRole("radio", {
        name: /This repository/i,
      });

      expect(globalRadio.getAttribute("data-state")).toBe("checked");
      expect(overrideRadio.getAttribute("data-state")).toBe("unchecked");

      globalRadio.focus();
      expect(document.activeElement).toBe(globalRadio);
      fireEvent.keyDown(globalRadio, {
        key: "ArrowDown",
        code: "ArrowDown",
        bubbles: true,
      });
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });

      await waitFor(() => {
        expect(screen.getByLabelText("Prefix")).toBeTruthy();
      });

      // From the editing group (override checked), ArrowUp selects global and
      // cancels the fresh edit back to the inherited view.
      const editingOverride = screen.getByRole("radio", {
        name: /This repository/i,
      });
      expect(editingOverride.getAttribute("data-state")).toBe("checked");
      editingOverride.focus();
      fireEvent.keyDown(editingOverride, {
        key: "ArrowUp",
        code: "ArrowUp",
        bubbles: true,
      });
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });

      await waitFor(() => {
        expect(screen.queryByLabelText("Prefix")).toBeNull();
      });
      expect(
        screen
          .getByRole("radio", { name: /Global default/i })
          .getAttribute("data-state"),
      ).toBe("checked");
    });

    it("exposes accessible names on both radio options and is tab-reachable", async () => {
      const user = userEvent.setup();
      renderSection({ status: "absent" }, noop, null);
      const globalRadio = screen.getByRole("radio", {
        name: /Global default/i,
      });
      const overrideRadio = screen.getByRole("radio", {
        name: /This repository/i,
      });
      expect(globalRadio).toBeTruthy();
      expect(overrideRadio).toBeTruthy();

      // Tab reaches the radio group (checked item is the tab stop).
      await user.tab();
      expect(document.activeElement).toBe(globalRadio);
    });
  });

  describe("accessibility", () => {
    it("wraps the section body in a polite live region", () => {
      renderSection({ status: "absent" }, noop, null);
      const shell = screen.getByTestId("repo-branch-prefix-section");
      const live = shell.querySelector('[aria-live="polite"]');
      expect(live).toBeTruthy();
    });
  });
});
