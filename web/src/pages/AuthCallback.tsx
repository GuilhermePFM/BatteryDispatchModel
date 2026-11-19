import { WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";

/** Where Cognito sends the browser back with the authorization code. */
export function AuthCallback() {
  const { completeSignIn } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // The code can be redeemed once; StrictMode runs effects twice in development.
    if (started.current) return;
    started.current = true;
    completeSignIn()
      .then((returnTo) => navigate(returnTo || "/run", { replace: true }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [completeSignIn, navigate]);

  return (
    <div className="page">
      <div className="wrap">
        {error ? (
          <div className="status-panel">
            <div className="banner error" role="alert">
              <WarningCircle size={18} aria-hidden="true" />
              <span>
                <span className="banner-title">Sign-in did not complete.</span> {error}
              </span>
            </div>
            <div className="actions">
              <Link className="btn btn-primary" to="/run">
                Back to the form
              </Link>
            </div>
          </div>
        ) : (
          <div className="status-panel" aria-live="polite">
            <span>Signing you in.</span>
            <div className="progress indeterminate">
              <span />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
