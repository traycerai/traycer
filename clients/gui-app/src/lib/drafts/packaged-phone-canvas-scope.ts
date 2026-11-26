export type PackagedPhoneCanvasScope =
  | { readonly kind: "not-phone" }
  | { readonly kind: "held" }
  | {
      readonly kind: "admitted";
      readonly scope: { readonly kind: "phone-app"; readonly id: "bundled-app" };
    };

let packagedPhoneCanvasScope: PackagedPhoneCanvasScope = { kind: "not-phone" };

/** The mobile entry resolves scope once, before the composer store loads. */
export function registerPackagedPhoneCanvasScope(admitted: boolean): void {
  if (packagedPhoneCanvasScope.kind !== "not-phone") return;
  packagedPhoneCanvasScope = admitted
    ? { kind: "admitted", scope: { kind: "phone-app", id: "bundled-app" } }
    : { kind: "held" };
}

export function readPackagedPhoneCanvasScope(): PackagedPhoneCanvasScope {
  return packagedPhoneCanvasScope;
}
