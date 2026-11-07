import { describe, expect, it } from "vitest";
import {
  grantedPermissionRoleSchema,
  grantedRole,
} from "@traycer/protocol/common/permission-role";
import { permissionRoleSchema } from "@traycer/protocol/common/_internal/schemas";
import { LatestPermissionRoleSchema } from "@traycer/protocol/host/epic/unary-schemas";

describe("grantedRole", () => {
  it("resolves the roles somebody holds to themselves", () => {
    expect(grantedRole("owner")).toBe("owner");
    expect(grantedRole("editor")).toBe("editor");
  });

  it("resolves the retired viewer role, an unknown role and no role to no access", () => {
    expect(grantedRole("viewer")).toBeNull();
    expect(grantedRole("some-role-a-newer-host-invented")).toBeNull();
    expect(grantedRole("")).toBeNull();
    expect(grantedRole(null)).toBeNull();
  });
});

describe("the retired viewer role in the decodable vocabulary", () => {
  it("still parses, so released peers and existing rooms keep decoding", () => {
    expect(permissionRoleSchema.parse("viewer")).toBe("viewer");
    expect(LatestPermissionRoleSchema.parse("viewer")).toBe("viewer");
  });

  it("holds every granted role, so a grant can never name a role the decoder rejects", () => {
    for (const role of grantedPermissionRoleSchema.options) {
      expect(permissionRoleSchema.safeParse(role).success).toBe(true);
      expect(LatestPermissionRoleSchema.safeParse(role).success).toBe(true);
    }
  });

  it("grants nothing for the decodable role that is not granted", () => {
    const notGranted = permissionRoleSchema.options.filter(
      (role) => !grantedPermissionRoleSchema.options.some((g) => g === role),
    );
    expect(notGranted).toEqual(["viewer"]);
    for (const role of notGranted) {
      expect(grantedRole(role)).toBeNull();
    }
  });
});
