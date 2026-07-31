import { describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { TuiForkProfileAdmissionSubcode } from "@traycer/protocol/host/agent/tui/unary-schemas";
import {
  resolveTuiForkRejectionView,
  TuiForkProfileRejectedError,
} from "@/lib/tui-fork-profile-rejection";

const LABELS = {
  targetLabel: "Work",
  sourceLabel: "Personal",
} as const;

function preflightError(
  subcode: TuiForkProfileAdmissionSubcode,
): TuiForkProfileRejectedError {
  return new TuiForkProfileRejectedError(subcode, `preflight: ${subcode}`);
}

function prepareLaunchError(message: string): HostRpcError {
  return new HostRpcError({
    code: "E_INVALID_ARGUMENT",
    message,
    requestId: "req-test",
    method: "agent.tui.prepareLaunch",
    fatalDetails: null,
  });
}

describe("resolveTuiForkRejectionView", () => {
  it("maps each TuiForkProfileRejectedError subcode to dialog copy", () => {
    expect(
      resolveTuiForkRejectionView(preflightError("SCOPE_MISMATCH"), LABELS),
    ).toEqual({
      message:
        "Can't continue this session under Work. It doesn't share conversation history with Personal. Choose a shared profile, or start a new terminal agent.",
      residueNote: null,
    });

    expect(
      resolveTuiForkRejectionView(
        preflightError("TARGET_PROFILE_UNAVAILABLE"),
        LABELS,
      ),
    ).toEqual({
      message:
        "Can't continue this session under Work. That profile isn't available right now - it may be signed out, still finishing setup, or no longer supported. Choose a different profile, or start a new terminal agent.",
      residueNote: null,
    });

    expect(
      resolveTuiForkRejectionView(
        preflightError("FORK_SOURCE_NOT_FOUND"),
        LABELS,
      ),
    ).toEqual({
      message:
        "Can't continue this session - the source terminal agent couldn't be identified. Close and reopen this tab, then try again.",
      residueNote: null,
    });

    expect(
      resolveTuiForkRejectionView(
        preflightError("FORK_SOURCE_AMBIGUOUS"),
        LABELS,
      ),
    ).toEqual({
      message:
        "Can't continue this session - the source terminal agent couldn't be identified. Close and reopen this tab, then try again.",
      residueNote: null,
    });

    expect(
      resolveTuiForkRejectionView(preflightError("SOURCE_NOT_READY"), LABELS),
    ).toEqual({
      message:
        "This session has no conversation yet - send a message before forking.",
      residueNote: null,
    });
  });

  it("parses a late agent.tui.prepareLaunch SOURCE_NOT_READY prefix into subcode + residueNote (fork-before-first-turn)", () => {
    const view = resolveTuiForkRejectionView(
      prepareLaunchError(
        "SOURCE_NOT_READY: terminal agent session 'src-1' has no conversation yet - send it a message before forking. If a worktree or workspace folder was already prepared for this launch attempt, it has not been removed - review it from workspace/worktree management if unused.",
      ),
      LABELS,
    );
    expect(view).toEqual({
      message:
        "This session has no conversation yet - send a message before forking.",
      residueNote:
        "terminal agent session 'src-1' has no conversation yet - send it a message before forking. If a worktree or workspace folder was already prepared for this launch attempt, it has not been removed - review it from workspace/worktree management if unused.",
    });
  });

  it("parses a late agent.tui.prepareLaunch HostRpcError prefix into subcode + residueNote", () => {
    const view = resolveTuiForkRejectionView(
      prepareLaunchError(
        "SCOPE_MISMATCH: profiles don't share history. Local worktree residue may remain.",
      ),
      LABELS,
    );
    expect(view).toEqual({
      message:
        "Can't continue this session under Work. It doesn't share conversation history with Personal. Choose a shared profile, or start a new terminal agent.",
      residueNote:
        "profiles don't share history. Local worktree residue may remain.",
    });
  });

  it("parses late FORK_SOURCE_NOT_FOUND and FORK_SOURCE_AMBIGUOUS prefixes", () => {
    expect(
      resolveTuiForkRejectionView(
        prepareLaunchError("FORK_SOURCE_NOT_FOUND: missing source row"),
        LABELS,
      ),
    ).toEqual({
      message:
        "Can't continue this session - the source terminal agent couldn't be identified. Close and reopen this tab, then try again.",
      residueNote: "missing source row",
    });

    expect(
      resolveTuiForkRejectionView(
        prepareLaunchError("FORK_SOURCE_AMBIGUOUS: two matching rows"),
        LABELS,
      ),
    ).toEqual({
      message:
        "Can't continue this session - the source terminal agent couldn't be identified. Close and reopen this tab, then try again.",
      residueNote: "two matching rows",
    });
  });

  it("returns null for an unrelated error", () => {
    expect(
      resolveTuiForkRejectionView(new Error("worktree failed"), LABELS),
    ).toBeNull();
  });

  it("returns null for a HostRpcError from a different method", () => {
    const error = new HostRpcError({
      code: "E_INVALID_ARGUMENT",
      message: "SCOPE_MISMATCH: should not match wrong method",
      requestId: "req-test",
      method: "agent.tui.validateForkProfile",
      fatalDetails: null,
    });
    expect(resolveTuiForkRejectionView(error, LABELS)).toBeNull();
  });

  it("returns null for prepareLaunch errors that match no recognized shape", () => {
    expect(
      resolveTuiForkRejectionView(
        prepareLaunchError("TARGET_PROFILE_UNAVAILABLE: not reshaped here"),
        LABELS,
      ),
    ).toBeNull();
    expect(
      resolveTuiForkRejectionView(
        prepareLaunchError("plain host failure with no subcode prefix"),
        LABELS,
      ),
    ).toBeNull();
  });

  it("maps a late lifecycle-error rejection (TOCTOU: tombstoned after preflight) to the TARGET_PROFILE_UNAVAILABLE inline copy + residue paragraph", () => {
    const message =
      'Profile "work-2" for provider "codex" was removed and can no longer be used. If a worktree or workspace folder was already prepared for this launch attempt, it has not been removed - review it from workspace/worktree management if unused.';
    const view = resolveTuiForkRejectionView(
      new HostRpcError({
        code: "RPC_ERROR",
        message,
        requestId: "req-test",
        method: "agent.tui.prepareLaunch",
        fatalDetails: null,
      }),
      LABELS,
    );
    expect(view).toEqual({
      message:
        "Can't continue this session under Work. That profile isn't available right now - it may be signed out, still finishing setup, or no longer supported. Choose a different profile, or start a new terminal agent.",
      residueNote: message,
    });
  });

  it("recognizes every profile-lifecycle message shape (not-found, setup-pending, unsupported provider)", () => {
    const shapes = [
      'No profile "work-2" is registered for provider "codex".',
      'Profile "work-2" for provider "codex" is still completing setup and cannot be used yet.',
      'Provider "cursor" does not support managed profiles.',
    ];
    for (const message of shapes) {
      const view = resolveTuiForkRejectionView(
        new HostRpcError({
          code: "RPC_ERROR",
          message,
          requestId: "req-test",
          method: "agent.tui.prepareLaunch",
          fatalDetails: null,
        }),
        LABELS,
      );
      expect(view?.message).toBe(
        "Can't continue this session under Work. That profile isn't available right now - it may be signed out, still finishing setup, or no longer supported. Choose a different profile, or start a new terminal agent.",
      );
      expect(view?.residueNote).toBe(message);
    }
  });

  it("does not treat an E_INVALID_ARGUMENT-coded error as a lifecycle rejection even if the message text matches", () => {
    const message =
      'Profile "work-2" for provider "codex" was removed and can no longer be used.';
    expect(
      resolveTuiForkRejectionView(prepareLaunchError(message), LABELS),
    ).toBeNull();
  });
});
