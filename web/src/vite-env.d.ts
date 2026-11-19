/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_MODE?: "cognito" | "dev";
  readonly VITE_COGNITO_AUTHORITY?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
  readonly VITE_COGNITO_DOMAIN?: string;
  readonly VITE_API_MOCK?: string;
  readonly VITE_REPO_URL?: string;
  readonly VITE_SCENARIO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
