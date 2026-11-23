// Sign-in. In AWS: Cognito's managed login (Google) through
// oidc-client-ts, authorization code + PKCE, the user kept in memory only, and
// the ID token sent as the bearer (X-Authorization, see lib/api.ts) because it
// carries the email, when the provider shares one. Locally: a fake sign-in
// sending "Bearer dev:<sub>:<email>", which the API accepts only with
// AUTH_MODE=dev.
import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User } from "oidc-client-ts";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { authMode, cognito, origin } from "../lib/config";
import { messages } from "../i18n";

export const CALLBACK_PATH = "/auth/callback";
const DEV_KEY = "batteryplan:dev-user";

export interface Account {
  sub: string;
  /** Null when the identity provider withheld it. */
  email: string | null;
  name?: string;
}

interface AuthState {
  mode: "cognito" | "dev";
  account: Account | null;
  /** Bearer token for the API, or null when signed out. */
  token: string | null;
  /** True while a sign-in is being completed. */
  pending: boolean;
  /** Starts a sign-in that comes back to `returnTo`. */
  signIn: (returnTo?: string) => void;
  signOut: () => void;
  /** Call on a 401 from the API. */
  dropSession: () => void;
  /** Completes the redirect from Cognito; resolves to where the user was going. */
  completeSignIn: () => Promise<string>;
  /** Dev mode: the dialog asking for a name and an email is open. */
  devDialogOpen: boolean;
  closeDevDialog: () => void;
  /** Signs in and resolves to where the user was going. */
  devSignIn: (name: string, email: string) => string | undefined;
}

const AuthContext = createContext<AuthState | null>(null);

let manager: UserManager | null = null;
function userManager(): UserManager {
  if (!manager) {
    manager = new UserManager({
      authority: cognito.authority,
      client_id: cognito.clientId,
      redirect_uri: `${origin()}${CALLBACK_PATH}`,
      post_logout_redirect_uri: `${origin()}/`,
      response_type: "code",
      scope: "openid email profile",
      // The tokens stay in memory; only the PKCE state crosses the redirect.
      userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
      stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
      automaticSilentRenew: false,
      loadUserInfo: false,
    });
  }
  return manager;
}

function readDevUser(): Account | null {
  try {
    const raw = sessionStorage.getItem(DEV_KEY);
    return raw ? (JSON.parse(raw) as Account) : null;
  } catch {
    return null;
  }
}

function devSub(email: string): string {
  return email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dev-user";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [devUser, setDevUser] = useState<Account | null>(() => (authMode === "dev" ? readDevUser() : null));
  const [pending, setPending] = useState(false);
  const [devDialogOpen, setDevDialogOpen] = useState(false);
  const [devReturn, setDevReturn] = useState<string | undefined>();

  const account: Account | null = useMemo(() => {
    if (authMode === "dev") return devUser;
    if (!user || user.expired) return null;
    const profile = user.profile;
    return { sub: profile.sub, email: profile.email ? String(profile.email) : null, name: profile.name ? String(profile.name) : undefined };
  }, [user, devUser]);

  const token = useMemo(() => {
    if (authMode === "dev") return devUser ? `dev:${devUser.sub}:${devUser.email ?? ""}` : null;
    return user && !user.expired ? (user.id_token ?? null) : null;
  }, [user, devUser]);

  const signOut = useCallback(() => {
    if (authMode === "dev") {
      sessionStorage.removeItem(DEV_KEY);
      setDevUser(null);
      return;
    }
    void userManager().removeUser();
    setUser(null);
    // Cognito has no end_session_endpoint in its discovery document: its own logout route.
    if (cognito.domain && cognito.clientId) {
      const url = new URL(`${cognito.domain}/logout`);
      url.searchParams.set("client_id", cognito.clientId);
      url.searchParams.set("logout_uri", `${origin()}/`);
      window.location.assign(url.toString());
    }
  }, []);

  /** A 401 means the token is gone or stale: forget it, so the page offers sign-in again. */
  const dropSession = useCallback(() => {
    if (authMode === "dev") return;
    setUser(null);
    void userManager().removeUser();
  }, []);

  const signIn = useCallback((returnTo?: string) => {
    const target = returnTo ?? window.location.pathname + window.location.search;
    if (authMode === "dev") {
      setDevReturn(target);
      setDevDialogOpen(true);
      return;
    }
    if (!cognito.authority || !cognito.clientId) {
      window.alert(messages().layout.signInNotConfigured);
      return;
    }
    setPending(true);
    void userManager()
      .signinRedirect({ state: { returnTo: target } })
      .catch(() => setPending(false));
  }, []);

  const completeSignIn = useCallback(async () => {
    setPending(true);
    try {
      const signed = await userManager().signinRedirectCallback();
      setUser(signed);
      const state = signed.state as { returnTo?: string } | undefined;
      return state?.returnTo && state.returnTo.startsWith("/") ? state.returnTo : "/run";
    } finally {
      setPending(false);
    }
  }, []);

  const devSignIn = useCallback(
    (name: string, email: string) => {
      const next: Account = { sub: devSub(email), email: email.trim(), name: name.trim() || undefined };
      try {
        sessionStorage.setItem(DEV_KEY, JSON.stringify(next));
      } catch {
        /* memory only */
      }
      setDevUser(next);
      setDevDialogOpen(false);
      return devReturn;
    },
    [devReturn],
  );

  const value = useMemo<AuthState>(
    () => ({
      mode: authMode,
      account,
      token,
      pending,
      signIn,
      signOut,
      dropSession,
      completeSignIn,
      devDialogOpen,
      closeDevDialog: () => setDevDialogOpen(false),
      devSignIn,
    }),
    [account, token, pending, signIn, signOut, dropSession, completeSignIn, devDialogOpen, devSignIn],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth outside AuthProvider");
  return context;
}
