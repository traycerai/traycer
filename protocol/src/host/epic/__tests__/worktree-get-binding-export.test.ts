import { describe, expect, it } from "vitest";
import * as hostIndex from "@traycer/protocol/host/index";
import {
  hostRpcRegistry,
  worktreeGetBindingV10,
  worktreeGetBindingRequestSchema,
  worktreeGetBindingResponseSchema,
  workspaceBindingRemoveEntryV10,
  workspaceBindingRemoveEntryRequestSchema,
  workspaceBindingRemoveEntryResponseSchema,
} from "@traycer/protocol/host/index";

/**
 * `worktree.getBinding` is an additive read RPC used by non-chat surfaces
 * (terminal-agent toolbar) because they do not receive `chat.subscribe`
 * snapshots. The contract must be exported from `protocol/host/index`
 * alongside other worktree V10 contracts so consumers can import it through
 * the public module entry point.
 */
describe("worktree.getBinding export surface", () => {
  it("re-exports the worktreeGetBindingV10 contract from the host index barrel", () => {
    expect(hostIndex.worktreeGetBindingV10).toBeDefined();
    expect(worktreeGetBindingV10.method).toBe("worktree.getBinding");
    expect(worktreeGetBindingV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("registers worktree.getBinding at version 1.0 in the host registry", () => {
    const contract =
      hostRpcRegistry["worktree.getBinding"][1].versions[0].contract;
    expect(contract).toBe(worktreeGetBindingV10);
    expect(contract.requestSchema).toBe(worktreeGetBindingRequestSchema);
    expect(contract.responseSchema).toBe(worktreeGetBindingResponseSchema);
  });

  it("registers workspaceBinding.removeEntry at version 1.0 in the host registry", () => {
    expect(hostIndex.workspaceBindingRemoveEntryV10).toBeDefined();
    expect(workspaceBindingRemoveEntryV10.method).toBe(
      "workspaceBinding.removeEntry",
    );
    const contract =
      hostRpcRegistry["workspaceBinding.removeEntry"][1].versions[0].contract;
    expect(contract).toBe(workspaceBindingRemoveEntryV10);
    expect(contract.requestSchema).toBe(
      workspaceBindingRemoveEntryRequestSchema,
    );
    expect(contract.responseSchema).toBe(
      workspaceBindingRemoveEntryResponseSchema,
    );
  });
});
