export const AUTH_ERROR_DISK_FULL = "sign-in-disk-full";
export const DISK_FULL_SIGN_IN_TITLE = "Your disk is full.";
export const DISK_FULL_SIGN_IN_BODY =
  "Traycer could not save your sign-in. Free up some space to stay signed in.";
export const DISK_FULL_SIGN_IN_MESSAGE = `${DISK_FULL_SIGN_IN_TITLE} ${DISK_FULL_SIGN_IN_BODY}`;

export function isDiskFullSignInError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code: unknown = Reflect.get(error, "code");
  return (
    code === "ENOSPC" ||
    code === "EDQUOT" ||
    (error instanceof Error && error.message === AUTH_ERROR_DISK_FULL)
  );
}
