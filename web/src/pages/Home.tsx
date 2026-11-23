import { ArrowRight, Info, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Chart } from "../charts/Chart";
import { week } from "../charts/options";
import { usePalette } from "../charts/theme";
import { CONTRACT_VERSION, MODEL_VERSION, type Result, type RunRecord } from "../contracts/types";
import { Dashboard } from "../dashboard/Dashboard";
import { scenarioUrl } from "../lib/config";
import { brl, day, num, pct } from "../lib/format";

type Scenario =
  | { state: "loading" }
  | { state: "ready"; result: Result; example: boolean }
  | { state: "missing"; reason: string };

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
  return { state: "missing", reason: "The precomputed PLD scenario could not be loaded." };
}

function HeroChart({ result }: { result: Result | null }) {
  const palette = usePalette();
  const option = useMemo(() => (result ? week(result, palette, true) : null), [result, palette]);
  if (!option) return <div className="chart-placeholder" style={{ height: 300 }} aria-hidden="true" />;
  return <Chart option={option} height={300} label="The PLD and the battery's power over a representative week" />;
}

export function Home() {
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
            <h1>Is this battery worth buying in Brazil?</h1>
            <p className="hero-sub">
              Where to put it, and whether to contract it in the capacity auction or run it merchant on the hourly PLD. Change the financial case and see the answer move at once.
            </p>
            <div className="hero-ctas">
              <Link className="btn btn-primary" to="/run">
                Run your own <ArrowRight size={16} weight="bold" aria-hidden="true" />
              </Link>
              <Link className="btn btn-secondary" to="/methodology">
                Read the method
              </Link>
            </div>
          </div>
          <div className="hero-visual reveal reveal-2">
            <div className="hero-visual-caption">
              <span>The PLD, and what the battery did with it</span>
              <span className="num">{w.length ? `${day(w[0])} to ${day(w[w.length - 1])}` : ""}</span>
            </div>
            <HeroChart result={result} />
          </div>
        </div>
      </section>

      <section className="intro">
        <div className="wrap">
          <div className="intro-text">
            <p>
              A battery in Brazil can earn in two separate ways. Under a capacity contract (LRCAP) it is paid a fixed revenue, indexed by IPCA, and the ONS dispatches it: the PLD settlement belongs to the CONCAP, so arbitrage is no income. As a merchant asset it earns the difference between hours of the PLD and has no fixed revenue.
            </p>
            <p>
              The solver plans every hour of every submarket for both cases. The investment layer then turns those plans into cash flows, NPV, IRR, payback, the highest capex that still pays and the lowest bid that does. The <Link to="/methodology">methodology</Link> has the formulation, and you can <Link to="/run">run your own battery</Link>.
            </p>
          </div>
          {result ? (
            <dl className="spec">
              <div>
                <dt>Horizon</dt>
                <dd>{num(result.horizon.days)} days</dd>
              </div>
              <div>
                <dt>Decisions</dt>
                <dd>{num(result.horizon.hours)} hours</dd>
              </div>
              <div>
                <dt>Battery</dt>
                <dd>
                  {num(result.battery.power_mw, 0)} MW / {num(result.battery.duration_hours, 0)} h
                </dd>
              </div>
              <div>
                <dt>Round trip</dt>
                <dd>{pct(result.battery.round_trip_efficiency, 0)}</dd>
              </div>
              <div>
                <dt>Best submarket</dt>
                <dd>{best?.submarket ?? "n/a"}</dd>
              </div>
              <div>
                <dt>Merchant ceiling</dt>
                <dd>{brl(best?.balanced_year_brl)} / year</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </section>

      <section className="dashboard" aria-labelledby="scenario-title">
        <div className="wrap">
          <div className="dash-head">
            <h2 id="scenario-title">The hourly PLD, the precomputed run</h2>
            {result ? (
              <span className="dash-meta">
                {day(result.horizon.start)} to {day(result.horizon.end)}, four submarkets, contracted and merchant
              </span>
            ) : null}
          </div>
          {scenario.state === "ready" && scenario.example ? (
            <div className="banner" style={{ marginBottom: 20 }}>
              <Info size={18} aria-hidden="true" />
              <span>
                Development build: the scenario file is missing, so this shows the contract&apos;s example payload instead.
              </span>
            </div>
          ) : null}
          {scenario.state === "loading" ? (
            <div className="chart-placeholder" style={{ height: 240, borderRadius: 14 }} aria-label="Loading the scenario" />
          ) : scenario.state === "missing" ? (
            <div className="banner error" role="alert">
              <WarningCircle size={18} aria-hidden="true" />
              <span>
                <span className="banner-title">{scenario.reason}</span> Reload the page, or <Link to="/run">run a horizon yourself</Link>.
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
