// Runtime configuration, from Vite's env at build time. Redirect URIs are
// derived from the page's own origin so one build serves any host.

export const apiMock = import.meta.env.VITE_API_MOCK === "1" || import.meta.env.VITE_API_MOCK === "true";

/** Mock mode always signs in the dev way: the shim accepts any dev token. */
export const authMode: "cognito" | "dev" = apiMock ? "dev" : import.meta.env.VITE_AUTH_MODE === "cognito" ? "cognito" : "dev";

export const cognito = {
  authority: import.meta.env.VITE_COGNITO_AUTHORITY ?? "",
  clientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "",
  domain: (import.meta.env.VITE_COGNITO_DOMAIN ?? "").replace(/\/$/, ""),
};

export const repoUrl = (import.meta.env.VITE_REPO_URL ?? "https://github.com/GuilhermePFM/BatteryCase/blob/main").replace(/\/$/, "");

export const scenarioUrl = import.meta.env.VITE_SCENARIO_URL || "/scenarios/pld-2025-2026.json";

export const contactEmail = "gui@gmachado.dev";

export function origin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}
