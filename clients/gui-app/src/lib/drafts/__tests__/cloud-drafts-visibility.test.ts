import { describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import { cloudDraftsDirectoryIsVisible } from "@/lib/drafts/cloud-drafts-visibility";

function error(code: RpcErrorCode): HostRpcError {
  return new HostRpcError({
    code,
    message: code,
    requestId: "req-1",
    method: "epic.listCloudChats",
    fatalDetails: null,
  });
}

describe("cloudDraftsDirectoryIsVisible", () => {
  it("hides when the host omitted a scope id", () => {
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: null,
        error: null,
        isPending: false,
        isSuccess: true,
      }),
    ).toBe(false);
  });

  it("hides on old-host errors", () => {
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: error("E_HOST_UNSUPPORTED"),
        isPending: false,
        isSuccess: false,
      }),
    ).toBe(false);
  });

  it("hides on any settled list error, including free-tier FORBIDDEN", () => {
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: error("FORBIDDEN"),
        isPending: false,
        isSuccess: false,
      }),
    ).toBe(false);
  });

  it("shows while a capable host is listing or has listed", () => {
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: null,
        isPending: true,
        isSuccess: false,
      }),
    ).toBe(true);
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: null,
        isPending: false,
        isSuccess: true,
      }),
    ).toBe(true);
  });
});
