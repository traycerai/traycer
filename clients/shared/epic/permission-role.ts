/**
 * The write predicate over an epic permission role, in the one place both the lane adapters and the renderer can reach.
 * It is three words of logic and it is worth a module because of the direction it must fail in.
 */
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";

export function isWritablePermissionRole(role: PermissionRole | null): boolean {
  return role === "owner" || role === "editor";
}
