import { ArrowRight, Info, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Chart } from "../charts/Chart";
import { week } from "../charts/options";
import { usePalette } from "../charts/theme";
import { CONTRACT_VERSION, MODEL_VERSION, type Result, type RunRecord } from "../contracts/types";
import { Dashboard } from "../dashboard/Dashboard";
import { useI18n } from "../i18n";
import { Rich } from "../i18n/Rich";
import { scenarioUrl } from "../lib/config";
import { brl, day, num, pct } from "../lib/format";

type Scenario =
  | { state: "loading" }
  | { state: "ready"; result: Result; example: boolean }
  | { state: "missing" };

/** Accepts a run-record with the result inline, or a bare result, of the current model only. */
function resultOf(payload: unknown): Result | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Partial<RunRecord> & Partial<Result>;
  const result = record.result && typeof record.result === "object" ? record.result : (record as Result);
  return result.version === CONTRACT_VERSION && result.model_version === MODEL_VERSION && result.detail ? result : null;
}

async function loadScenario(): Promise<Scenario> {
  try {
    const response = await fetch(scenarioUrl, { headers: { Accept: "application/json" } });
    // A static host answers a missing file with the app's index.html.
    const type = response.headers.get("Content-Type") ?? "";
    if (response.ok && !type.includes("text/html")) {
      const result = resultOf(await response.json());
      if (result) return { state: "ready", result, example: false };
    }
  } catch {
    // fall through
  }
  if (import.meta.env.DEV) {
    const example = await import("../../../contracts/examples/v2/result.example.json");
    const result = resultOf(example.default);
    if (result) return { state: "ready", result, example: true };
  }
  return { state: "missing" };
}

function HeroChart({ result }: { result: Result | null }) {
  const { locale, t } = useI18n();
  const palette = usePalette();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- what it builds reads the active language
  const option = useMemo(() => (result ? week(result, palette, true) : null), [result, palette, locale]);
  if (!option) return <div className="chart-placeholder" style={{ height: 300 }} aria-hidden="true" />;
  return <Chart option={option} height={300} label={t.home.heroChart} />;
}

export function Home() {
  const { t: all } = useI18n();
  const t = all.home;
  const [scenario, setScenario] = useState<Scenario>({ state: "loading" });
  useEffect(() => {
    let live = true;
    loadScenario().then((s) => live && setScenario(s));
    return () => {
      live = false;
    };
  }, []);
  const result = scenario.state === "ready" ? scenario.result : null;
  const w = result?.detail.week.hora ?? [];
  const best = result?.ranking[0];

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="reveal">
            <h1>{t.title}</h1>
            <p className="hero-sub">{t.sub}</p>
            <div className="hero-ctas">
              <Link className="btn btn-primary" to="/run">
                {t.runOwn} <ArrowRight size={16} weight="bold" aria-hidden="true" />
              </Link>
              <Link className="btn btn-secondary" to="/methodology">
                {t.readMethod}
              </Link>
            </div>
          </div>
          <div className="hero-visual reveal reveal-2">
            <div className="hero-visual-caption">
              <span>{t.heroCaption}</span>
              <span className="num">{w.length ? all.common.range(day(w[0]), day(w[w.length - 1])) : ""}</span>
            </div>
            <HeroChart result={result} />
          </div>
        </div>
      </section>

      <section className="intro">
        <div className="wrap">
          <div className="intro-text">
            <p>{t.intro1}</p>
            <p>
              <Rich
                text={t.intro2}
                tags={{
                  method: (text) => <Link to="/methodology">{text}</Link>,
                  run: (text) => <Link to="/run">{text}</Link>,
                }}
              />
            </p>
          </div>
          {result ? (
            <dl className="spec">
              <div>
                <dt>{t.horizon}</dt>
                <dd>{t.days(num(result.horizon.days))}</dd>
              </div>
              <div>
                <dt>{t.decisions}</dt>
                <dd>{t.hours(num(result.horizon.hours))}</dd>
              </div>
              <div>
                <dt>{t.battery}</dt>
                <dd>
                  {num(result.battery.power_mw, 0)} MW / {num(result.battery.duration_hours, 0)} h
                </dd>
              </div>
              <div>
                <dt>{t.roundTrip}</dt>
                <dd>{pct(result.battery.round_trip_efficiency, 0)}</dd>
              </div>
              <div>
                <dt>{t.bestSubmarket}</dt>
                <dd>{best?.submarket ?? all.common.na}</dd>
              </div>
              <div>
                <dt>{t.merchantCeiling}</dt>
                <dd>{t.perYear(brl(best?.balanced_year_brl))}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </section>

      <section className="dashboard" aria-labelledby="scenario-title">
        <div className="wrap">
          <div className="dash-head">
            <h2 id="scenario-title">{t.scenarioTitle}</h2>
            {result ? (
              <span className="dash-meta">{t.scenarioMeta(day(result.horizon.start), day(result.horizon.end))}</span>
            ) : null}
          </div>
          {scenario.state === "ready" && scenario.example ? (
            <div className="banner" style={{ marginBottom: 20 }}>
              <Info size={18} aria-hidden="true" />
              <span>{t.devExample}</span>
            </div>
          ) : null}
          {scenario.state === "loading" ? (
            <div className="chart-placeholder" style={{ height: 240, borderRadius: 14 }} aria-label={t.loading} />
          ) : scenario.state === "missing" ? (
            <div className="banner error" role="alert">
              <WarningCircle size={18} aria-hidden="true" />
              <span>
                <span className="banner-title">{t.scenarioMissing}</span>
                <Rich text={t.reload} tags={{ run: (text) => <Link to="/run">{text}</Link> }} />
              </span>
            </div>
          ) : (
            <Dashboard result={scenario.result} />
          )}
        </div>
      </section>
    </>
  );
}
