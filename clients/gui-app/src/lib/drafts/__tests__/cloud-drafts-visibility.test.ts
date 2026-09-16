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

  it("hides on old-host errors even while the query is still pending", () => {
    // `isPending` on its own keeps the section visible, so this case can only
    // pass if the unsupported classification actually fires - with the
    // settled flags it would read `false` for any error at all, including
    // `null`.
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: error("E_HOST_UNSUPPORTED"),
        isPending: true,
        isSuccess: false,
      }),
    ).toBe(false);
  });

  it("hides free-tier FORBIDDEN by SETTLING, not by classifying it", () => {
    // Free-tier arrives as FORBIDDEN and is deliberately not classified: what
    // hides the section is the query having settled without success. Both
    // halves are asserted so the pair states the mechanism rather than
    // restating a `false` that any error value would produce.
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: error("FORBIDDEN"),
        isPending: false,
        isSuccess: false,
      }),
    ).toBe(false);
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: error("FORBIDDEN"),
        isPending: true,
        isSuccess: false,
      }),
    ).toBe(true);
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
