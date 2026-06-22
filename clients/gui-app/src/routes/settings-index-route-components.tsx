import { Navigate } from "@tanstack/react-router";

export function SettingsIndexRedirect() {
  return <Navigate to="/settings/general" replace />;
}
