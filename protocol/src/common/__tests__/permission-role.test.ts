import { describe, expect, it } from "vitest";
import {
  grantedPermissionRoleSchema,
  grantedRole,
} from "@traycer/protocol/common/permission-role";
import { LatestPermissionRoleSchema } from "@traycer/protocol/host/epic/unary-schemas";

describe("grantedRole", () => {
  it("resolves the roles somebody holds to themselves", () => {
    expect(grantedRole("owner")).toBe("owner");
    expect(grantedRole("editor")).toBe("editor");
  });

  it("resolves the viewer role to the access of an editor", () => {
    expect(grantedRole("viewer")).toBe("editor");
  });

  it("resolves an unknown role and no role to no access", () => {
    expect(grantedRole("some-role-a-newer-host-invented")).toBeNull();
    expect(grantedRole("Viewer")).toBeNull();
    expect(grantedRole("VIEWER")).toBeNull();
    expect(grantedRole("")).toBeNull();
    expect(grantedRole(null)).toBeNull();
  });
});

describe("the viewer role in the decodable vocabulary", () => {
  it("still parses, so released peers and existing rooms keep decoding", () => {
    expect(LatestPermissionRoleSchema.parse("viewer")).toBe("viewer");
  });

  it("holds every granted role, so a grant can never name a role the decoder rejects", () => {
    for (const role of grantedPermissionRoleSchema.options) {
      expect(LatestPermissionRoleSchema.safeParse(role).success).toBe(true);
    }
  });

  it("keeps viewer as the one decodable role that is not itself a granted role, and it reads as editor", () => {
    const notGranted = LatestPermissionRoleSchema.options.filter(
      (role) => !grantedPermissionRoleSchema.options.some((g) => g === role),
    );
    expect(notGranted).toEqual(["viewer"]);
    expect(grantedRole("viewer")).toBe("editor");
  });
});
