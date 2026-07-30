import { describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { TuiForkProfileAdmissionSubcode } from "@traycer/protocol/host/agent/tui/unary-schemas";
import { TuiForkProfileRejectedError } from "@/hooks/agent/use-create-tui-agent";
import { resolveTuiForkRejectionView } from "@/lib/tui-fork-profile-rejection";

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

  it("returns null for prepareLaunch errors without a recognized subcode prefix", () => {
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
});
