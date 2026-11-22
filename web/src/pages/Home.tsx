import { ArrowRight, Info } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Chart } from "../charts/Chart";
import { week } from "../charts/options";
import { usePalette } from "../charts/theme";
import type { Result, RunRecord } from "../contracts/types";
import { Dashboard } from "../dashboard/Dashboard";
import { scenarioUrl } from "../lib/config";
import { day, gbp, num, pct } from "../lib/format";

type Scenario =
  | { state: "loading" }
  | { state: "ready"; result: Result; example: boolean }
  | { state: "missing"; reason: string };

/** Accepts a run-record with the result inline, or a bare result. */
function resultOf(payload: unknown): Result | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Partial<RunRecord> & Partial<Result>;
  if (record.result && typeof record.result === "object") return record.result;
  if (record.headline && record.series) return record as Result;
  return null;
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
    const example = await import("../../../contracts/examples/run-record.example.json");
    const result = resultOf(example.default);
    if (result) return { state: "ready", result, example: true };
  }
  return { state: "missing", reason: "No precomputed scenario is published yet." };
}

function HeroChart({ result }: { result: Result | null }) {
  const palette = usePalette();
  const option = useMemo(() => (result ? week(result, palette, true) : null), [result, palette]);
  if (!option) return <div className="chart-placeholder" style={{ height: 300 }} aria-hidden="true" />;
  return <Chart option={option} height={300} label="Prices and the battery's power over a representative week" />;
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
  const w = result?.series.week.timestamp ?? [];

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="reveal">
            <h1>A battery that trades two power markets</h1>
            <p className="hero-sub">
              Half-hourly arbitrage across two GB markets, solved as a mixed-integer program with a priced cycle budget.
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
              <span>Prices, and what the battery did with them</span>
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
              A grid battery buys energy when it is cheap and sells it when it is dear. This one can trade in two markets: Market 1 settles every half hour, and
              Market 2 is bought and sold in blocks of an hour. The plan decides, for every half hour, how much to charge or deliver and in which market, so
              that profit is as high as the physics, the losses and the battery&apos;s wear allow.
            </p>
            <p>
              Wear is the hard part. Each full cycle uses up some of a finite cycle life, so the model puts a price on a cycle and finds that price by a
              cutting-plane method on the Lagrangian dual, solving each window with HiGHS. The{" "}
              <Link to="/methodology">methodology</Link> has the formulation, and you can <Link to="/run">run your own battery</Link> on your own prices.
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
                <dd>{num(result.horizon.periods)} half hours</dd>
              </div>
              <div>
                <dt>Battery</dt>
                <dd>
                  {num(result.battery.power_discharge_mw, 1)} MW / {num(result.battery.volume_mwh, 1)} MWh
                </dd>
              </div>
              <div>
                <dt>Round trip</dt>
                <dd>{pct(result.battery.round_trip_efficiency, 2)}</dd>
              </div>
              <div>
                <dt>Profit</dt>
                <dd>{gbp(result.headline.profit_gbp)}</dd>
              </div>
              <div>
                <dt>Cycle value</dt>
                <dd>{result.certificate && result.certificate.cycle_value > 0 ? `£${num(result.certificate.cycle_value, 2)}` : "not binding"}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </section>

      <section className="dashboard" aria-labelledby="scenario-title">
        <div className="wrap">
          <div className="dash-head">
            <h2 id="scenario-title">The precomputed run</h2>
            {result ? (
              <span className="dash-meta">
                {day(result.horizon.start)} to {day(result.horizon.end)}, solved one day at a time with a day of lookahead
              </span>
            ) : null}
          </div>
          {scenario.state === "ready" && scenario.example ? (
            <div className="banner" style={{ marginBottom: 20 }}>
              <Info size={18} aria-hidden="true" />
              <span>
                Development build: the scenario file is missing, so this shows the contract&apos;s small example payload instead.
              </span>
            </div>
          ) : null}
          {scenario.state === "loading" ? (
            <div className="chart-placeholder" style={{ height: 240, borderRadius: 14 }} aria-label="Loading the scenario" />
          ) : scenario.state === "missing" ? (
            <div className="banner">
              <Info size={18} aria-hidden="true" />
              <span>
                <span className="banner-title">{scenario.reason}</span> <Link to="/run">Run a horizon yourself</Link>.
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
