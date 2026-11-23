import { GithubLogo, SignIn, SignOut } from "@phosphor-icons/react";
import { Suspense } from "react";
import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { DevSignIn } from "../auth/DevSignIn";
import { LOCALES, useI18n } from "../i18n";
import { apiMock, contactEmail, repoUrl } from "../lib/config";

function Account() {
  const { account, signIn, signOut, mode, pending } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  if (account) {
    const label = account.email ?? account.name ?? t.layout.signedIn;
    return (
      <div className="account">
        <span className="account-email" title={label}>
          {label}
        </span>
        <button type="button" className="btn btn-quiet" onClick={signOut} aria-label={t.layout.signOut}>
          <SignOut size={16} aria-hidden="true" />
          <span className="hide-xs">{t.layout.signOut}</span>
        </button>
      </div>
    );
  }
  const signInLabel = mode === "dev" ? t.layout.signInDev : t.layout.signIn;
  return (
    <div className="account">
      <button type="button" className="btn btn-quiet" disabled={pending} aria-label={signInLabel} onClick={() => signIn(location.pathname + location.search)}>
        <SignIn size={16} className="show-xs" aria-hidden="true" />
        <span className="hide-xs">{signInLabel}</span>
      </button>
    </div>
  );
}

function LanguageSwitch() {
  const { locale, t, setLocale } = useI18n();
  return (
    <div className="segmented lang-switch" role="group" aria-label={t.layout.language}>
      {LOCALES.map(({ code, short, name }) => (
        <button key={code} type="button" lang={code} aria-pressed={locale === code} aria-label={name} title={name} onClick={() => setLocale(code)}>
          {short}
        </button>
      ))}
    </div>
  );
}

export function Layout() {
  const { t } = useI18n();
  const repoHome = repoUrl.replace(/\/blob\/[^/]+$/, "");
  return (
    <>
      <a className="visually-hidden" href="#main">
        {t.layout.skip}
      </a>
      <header className="site-header">
        <div className="wrap">
          <Link to="/" className="brand" aria-label={t.layout.home}>
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
            </span>
            <span className="brand-name">BatteryPlan</span>
          </Link>
          <nav className="nav" aria-label={t.layout.mainNav}>
            <NavLink to="/" end className="hide-sm">
              {t.layout.results}
            </NavLink>
            <NavLink to="/run">{t.layout.run}</NavLink>
            <NavLink to="/methodology">{t.layout.method}</NavLink>
          </nav>
          <div className="header-actions">
            <Account />
            <LanguageSwitch />
          </div>
        </div>
      </header>
      {apiMock ? (
        <div className="wrap" style={{ paddingTop: 10 }}>
          <div className="banner">{t.layout.mock}</div>
        </div>
      ) : null}
      <main id="main">
        <Suspense fallback={<div className="page" />}>
          <Outlet />
        </Suspense>
      </main>
      <footer className="site-footer">
        <div className="wrap">
          <span>{t.layout.footer}</span>
          <nav aria-label={t.layout.footerNav}>
            <a href={repoHome}>
              <GithubLogo size={15} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
              {t.layout.source}
            </a>
            <Link to="/privacy">{t.layout.privacy}</Link>
            <a href={`mailto:${contactEmail}`}>{t.layout.contact}</a>
          </nav>
        </div>
      </footer>
      <DevSignIn />
      <ScrollRestoration />
    </>
  );
}
