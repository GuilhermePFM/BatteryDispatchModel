import { GithubLogo, SignOut } from "@phosphor-icons/react";
import { Suspense } from "react";
import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { DevSignIn } from "../auth/DevSignIn";
import { apiMock, contactEmail, repoUrl } from "../lib/config";

function Account() {
  const { account, signIn, signOut, mode, pending } = useAuth();
  const location = useLocation();
  if (account) {
    const label = account.email ?? account.name ?? "Signed in";
    return (
      <div className="account">
        <span className="account-email" title={label}>
          {label}
        </span>
        <button type="button" className="btn btn-quiet" onClick={signOut} aria-label="Sign out">
          <SignOut size={16} aria-hidden="true" />
          <span className="hide-xs">Sign out</span>
        </button>
      </div>
    );
  }
  return (
    <div className="account">
      <button type="button" className="btn btn-quiet" disabled={pending} onClick={() => signIn(location.pathname + location.search)}>
        {mode === "dev" ? "Sign in (dev)" : "Sign in"}
      </button>
    </div>
  );
}

export function Layout() {
  const repoHome = repoUrl.replace(/\/blob\/[^/]+$/, "");
  return (
    <>
      <a className="visually-hidden" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="wrap">
          <Link to="/" className="brand" aria-label="BatteryPlan, home">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
            </span>
            <span className="brand-name">BatteryPlan</span>
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end className="hide-sm">
              Results
            </NavLink>
            <NavLink to="/run">Run</NavLink>
            <NavLink to="/methodology">Method</NavLink>
          </nav>
          <Account />
        </div>
      </header>
      {apiMock ? (
        <div className="wrap" style={{ paddingTop: 10 }}>
          <div className="banner">Mock API: runs are simulated in this tab and nothing leaves the browser.</div>
        </div>
      ) : null}
      <main id="main">
        <Suspense fallback={<div className="page" />}>
          <Outlet />
        </Suspense>
      </main>
      <footer className="site-footer">
        <div className="wrap">
          <span>BatteryPlan, by Guilherme Machado. Prices are GB market data, 2018 to 2020.</span>
          <nav aria-label="Footer">
            <a href={repoHome}>
              <GithubLogo size={15} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
              Source
            </a>
            <Link to="/privacy">Privacy</Link>
            <a href={`mailto:${contactEmail}`}>Contact</a>
          </nav>
        </div>
      </footer>
      <DevSignIn />
      <ScrollRestoration />
    </>
  );
}
