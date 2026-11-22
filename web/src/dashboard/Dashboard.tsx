// The results page of a run: the readings of notebooks/02_results_analysis.py,
// driven by the result payload (contracts/result.schema.json) alone.
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { hasData, isNum } from "../charts/adapters";
import { Figure } from "../charts/Figure";
import * as charts from "../charts/options";
import type { Palette } from "../charts/theme";
import type { Result } from "../contracts/types";
import { day, gbp, gbpShort, num, pct, ratio } from "../lib/format";

const SECTIONS = [
  ["profit", "Profit"],
  ["prices", "Prices"],
  ["dispatch", "Dispatch"],
  ["cycles", "Cycles"],
  ["spread", "Spread or level"],
  ["yardstick", "Yardstick and costs"],
] as const;

const CHECK_LABELS: Record<keyof Result["checks"], string> = {
  both_charging_and_delivering: "periods charging and delivering at once (§4.3)",
  market_2_not_flat_hours: "hours with a Market 2 decision not held flat (§4.5)",
  over_rate_limit: "periods over the rate limit (§4.3)",
  over_degraded_volume: "periods above the degraded volume (§4.1)",
  over_cycle_budget: "cycles spent beyond the budget (§4.6)",
};

const weekFull = (r: Result, p: Palette) => charts.week(r, p);
const harvestScatter = (r: Result, p: Palette) => charts.profitScatter(r, p, "harvestable_spread");
const levelScatter = (r: Result, p: Palette) => charts.profitScatter(r, p, "mean_price");

function Stat({ k, v, n }: { k: string; v: string; n?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {n ? <div className="n">{n}</div> : null}
    </div>
  );
}

function Headline({ r }: { r: Result }) {
  const h = r.headline;
  const cert = r.certificate;
  const failing = (Object.keys(CHECK_LABELS) as (keyof Result["checks"])[]).filter((k) => r.checks[k] > 0);
  const binding = cert && cert.cycle_value > 0;
  return (
    <>
      <div className="headline">
        <div className="headline-main">
          <div className="label">Trading profit</div>
          <div className="big">{gbp(h.profit_gbp)}</div>
          <p className="sub">
            {num(r.horizon.days)} days, {day(r.horizon.start)} to {day(r.horizon.end)}. A {num(r.battery.power_discharge_mw, 1)} MW,{" "}
            {num(r.battery.volume_mwh, 1)} MWh battery with a {pct(r.battery.round_trip_efficiency, 2)} round trip.
          </p>
        </div>
        <div className="stats">
          <Stat k="Cycles spent" v={num(h.cycles_used, h.cycles_used < 100 ? 1 : 0)} n={`of a ${num(h.cycle_budget)} budget`} />
          <Stat k="Profit per cycle" v={gbp(h.profit_per_cycle_gbp, 2)} n={`${num(r.cycles.cycles_per_day, 1)} cycles a day`} />
          <Stat k="Against one ideal cycle a day" v={ratio(r.yardstick.ratio)} n={`yardstick ${gbp(r.yardstick.total_gbp)}`} />
          <Stat k="Bought at, on average" v={isNum(h.mean_buy_price_gbp_per_mwh) ? `£${num(h.mean_buy_price_gbp_per_mwh, 2)}` : "n/a"} n={`${num(h.energy_bought_mwh)} MWh bought`} />
          <Stat k="Sold at, on average" v={isNum(h.mean_sell_price_gbp_per_mwh) ? `£${num(h.mean_sell_price_gbp_per_mwh, 2)}` : "n/a"} n={`${num(h.energy_delivered_mwh)} MWh delivered`} />
          {cert ? (
            <Stat
              k="Cycle value λ"
              v={`£${num(cert.cycle_value, 2)}`}
              n={
                cert.stopped_early
                  ? `stopped early, after ${cert.passes} pass${cert.passes === 1 ? "" : "es"}`
                  : binding
                    ? `${cert.passes} passes, search converged to a ${isNum(cert.dual_gap) ? pct(cert.dual_gap, 2) : "n/a"} dual gap`
                    : `budget not binding, ${cert.passes} pass${cert.passes === 1 ? "" : "es"}`
              }
            />
          ) : (
            <Stat k="Time charging, delivering, idle" v={`${pct(h.periods_charging / Math.max(1, h.periods), 0)} / ${pct(h.periods_discharging / Math.max(1, h.periods), 0)}`} n={`${pct(h.periods_idle / Math.max(1, h.periods), 0)} idle`} />
          )}
        </div>
      </div>
      <div className="checks">
        {failing.length === 0 ? (
          <span className="ok">
            <CheckCircle size={18} weight="bold" aria-hidden="true" /> All five constraint checks hold on the plan
          </span>
        ) : (
          failing.map((k) => (
            <span className="bad" key={k}>
              <WarningCircle size={18} weight="bold" aria-hidden="true" /> {num(r.checks[k])} {CHECK_LABELS[k]}
            </span>
          ))
        )}
        {cert?.stopped_early ? (
          <span className="bad">
            <WarningCircle size={18} weight="bold" aria-hidden="true" /> Stopped after {cert.passes} pass{cert.passes === 1 ? "" : "es"} to stay within the time limit
            {isNum(cert.plan_gap) ? `; the plan is within ${pct(cert.plan_gap, 2)} of the best possible.` : "; the plan is within budget."}
          </span>
        ) : null}
        {cert && isNum(cert.dual_bound_gbp) ? (
          <span>
            Dual bound {gbp(cert.dual_bound_gbp)}: the plan is within {pct(cert.plan_gap, 2)} of it.
          </span>
        ) : null}
      </div>
    </>
  );
}

function ProfitSplit({ r }: { r: Result }) {
  const s = r.profit_split;
  const a = s.time_arbitrage_gbp;
  const b = s.market_2_gap_gbp;
  const drawable = a >= 0 && b >= 0 && a + b > 0;
  return (
    <div className="split">
      {drawable ? (
        <div className="split-bar" role="img" aria-label={`Time arbitrage ${gbp(a)}, the Market 2 gap ${gbp(b)}`}>
          <span style={{ flex: a, background: "var(--charge)" }} />
          <span style={{ flex: b, background: "var(--discharge)" }} />
        </div>
      ) : null}
      <div className="split-legend">
        <span>
          <i className="swatch" style={{ background: "var(--charge)" }} />
          Time arbitrage, valued at Market 1 <b>{gbp(a)}</b>
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--discharge)" }} />
          What trading in Market 2 added <b>{gbp(b)}</b>
          {isNum(s.market_2_share) ? <span style={{ color: "var(--muted)" }}> ({pct(s.market_2_share)})</span> : null}
        </span>
      </div>
    </div>
  );
}

function YearlyTable({ r }: { r: Result }) {
  const y = r.series.yearly;
  if (!y.year.length) return null;
  return (
    <div className="fig">
      <h3>Year by year</h3>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Year</th>
              <th>Profit</th>
              <th>Cycles</th>
              <th>£ per cycle</th>
              <th>Mean price M1</th>
              <th>Mean price M2</th>
              <th>Day&apos;s range</th>
              <th>Harvestable</th>
              <th>vs yardstick, median day</th>
              <th>Days beating it</th>
            </tr>
          </thead>
          <tbody>
            {y.year.map((year, i) => (
              <tr key={year}>
                <td>{year}</td>
                <td>{gbp(y.profit_gbp[i])}</td>
                <td>{num(y.cycles[i], 0)}</td>
                <td>{gbp(y.profit_per_cycle[i], 2)}</td>
                <td>£{num(y.mean_price_1[i], 2)}</td>
                <td>£{num(y.mean_price_2[i], 2)}</td>
                <td>£{num(y.mean_day_range[i], 2)}</td>
                <td>£{num(y.mean_harvestable[i], 2)}</td>
                <td>{ratio(y.yardstick_median_ratio[i])}</td>
                <td>{pct(y.share_days_beating_yardstick[i], 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SpreadTable({ r }: { r: Result }) {
  return (
    <div className="fig">
      <h3>Which reading of &ldquo;the day&apos;s spread&rdquo; explains daily profit</h3>
      <p className="fig-note">Daily profit regressed on each reading, one day per point. The realised spread is an output of the dispatch, so it describes the result rather than explaining it.</p>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Reading</th>
              <th>£ per £/MWh</th>
              <th>R²</th>
            </tr>
          </thead>
          <tbody>
            {r.spread_explanation.map((row) => (
              <tr key={row.key}>
                <td>
                  {row.reading}
                  {!row.exogenous ? <span className="tag">output, not cause</span> : null}
                </td>
                <td>{num(row.gbp_per_unit, 2)}</td>
                <td>{num(row.r2, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Dashboard({ result: r, idPrefix = "" }: { result: Result; idPrefix?: string }) {
  const [budgetScale, setBudgetScale] = useState(true);
  const cyclesBuild = useCallback((res: Result, p: Palette) => charts.cyclesAgainstBudgets(res, p, budgetScale), [budgetScale]);
  const d = r.series.daily;
  const days = d.date.length;
  const manyDays = days > 1;
  const fitLabel = (column: "harvestable_spread" | "mean_price") => {
    const row = r.spread_explanation.find((s) => s.key === (column === "mean_price" ? "price_level" : "harvestable_spread"));
    return row && isNum(row.gbp_per_unit) ? `£${num(row.gbp_per_unit, 1)} per £/MWh, R² ${num(row.r2, 2)}` : "Not enough days to fit a line";
  };
  const worth = r.markets.share_days_worth_trading;
  const w = r.series.week;
  const weekSpan = w.timestamp.length ? `${day(w.timestamp[0])} to ${day(w.timestamp[w.timestamp.length - 1])}` : "";
  const id = (s: string) => `${idPrefix}${s}`;

  return (
    <div className="dash">
      <nav className="toc" aria-label="Dashboard sections">
        {SECTIONS.map(([key, label]) => (
          <a key={key} href={`#${id(key)}`}>
            {label}
          </a>
        ))}
      </nav>

      <Headline r={r} />

      <section className="section" id={id("profit")}>
        <h2>Where the profit came from</h2>
        <p className="section-lede">
          Every trade valued at Market 1&apos;s price for its own half hour, plus what using Market 2 added. The two parts sum to the profit exactly.
        </p>
        <ProfitSplit r={r} />
        <div className="figs figs-3">
          <Figure title="Cumulative profit" note={manyDays ? "Drag or scroll to zoom." : undefined} result={r} build={charts.cumulativeProfit} height={280} label="Cumulative profit by day" available={hasData(d.profit_gbp)} />
          <Figure title="Profit by month" result={r} build={charts.monthlyProfit} height={280} label="Profit by calendar month" available={hasData(r.series.monthly.profit_gbp)} />
        </div>
        <div className="figs">
          <YearlyTable r={r} />
        </div>
      </section>

      <section className="section" id={id("prices")}>
        <h2>The prices it was handed</h2>
        <p className="section-lede">
          At a {pct(r.battery.round_trip_efficiency, 2)} round trip, a sale has to beat its purchase by {pct(r.battery.breakeven_markup)} before a trade pays.
        </p>
        <div className="figs">
          <Figure title="Monthly mean price, with the inter-decile band" note="Click a market in the legend to hide it." result={r} build={charts.monthlyPrices} height={300} label="Monthly mean price per market with the 10th to 90th percentile band" available={hasData(r.series.monthly.price_1_mean) || hasData(r.series.monthly.price_2_mean)} />
        </div>
        <div className="figs figs-2">
          <Figure title={`Market 2 is dearer in ${pct(r.markets.share_market_2_dearer)} of periods`} note={`Mean gap £${num(r.markets.mean_spread_gbp_per_mwh, 2)}/MWh.`} result={r} build={charts.spreadHistogram} height={260} label="Histogram of Market 2 less Market 1 per half hour" available={r.series.spread_histogram.counts.some((c) => c > 0)} />
          <Figure title="The shape the battery trades against" note="Mean price by half hour of the day." result={r} build={charts.priceProfile} height={260} label="Mean price by half hour for both markets" available={hasData(r.series.profile.price_1)} />
        </div>
        <div className="figs">
          <Figure
            title={`The day's range against what a trade must clear${isNum(worth) ? `: ${pct(worth)} of days clear it` : ""}`}
            note="Floor to ceiling over both markets, and the breakeven a sale must reach after buying at the floor."
            result={r}
            build={charts.rangeVsBreakeven}
            height={300}
            label="Daily price range against the breakeven price"
            available={hasData(d.sell_ceiling)}
          />
        </div>
      </section>

      <section className="section" id={id("dispatch")}>
        <h2>What the plan does</h2>
        <p className="section-lede">
          Colour is the market, sign the direction: above the line is energy delivered, below it energy bought. Blue is Market 1, orange Market 2.
        </p>
        <div className="figs">
          <Figure
            title="A typical week, half hour by half hour"
            note={`${weekSpan}: the seven days whose profit is the median of every run of seven. Scroll on the chart to zoom.`}
            result={r}
            build={weekFull}
            height={520}
            label="Prices, power per market and storage over a representative week"
            available={w.timestamp.length > 0}
          />
          <Figure
            title="Every day at once: net power"
            note="A column per day, a row per half hour. Orange is delivering, blue charging."
            result={r}
            build={charts.netPowerHeatmap}
            height={340}
            label="Heatmap of net power by day and half hour"
            available={r.series.net_power.days.length > 0}
          />
        </div>
        <div className="figs figs-2">
          <Figure title="Each market is used for one side of the trade" note="Mean power by half hour." result={r} build={charts.profilePower} height={280} label="Mean charging and delivering power per market by half hour" available={hasData(r.series.profile.charge_1_mw)} />
          <Figure title="What the battery is doing, by hour" note="Share of days charging, delivering or idle at each half hour." result={r} build={charts.shareByHour} height={280} label="Share of periods charging, delivering and idle by half hour" available={hasData(r.series.profile.share_charging)} />
        </div>
        <div className="figs">
          <div className="fig">
            <h3>Bought and delivered, by market</h3>
            <div className="facts">
              <Stat k="Bought in Market 1" v={`${num(r.markets.bought_market_1_mwh)} MWh`} />
              <Stat k="Bought in Market 2" v={`${num(r.markets.bought_market_2_mwh)} MWh`} />
              <Stat k="Delivered to Market 1" v={`${num(r.markets.delivered_market_1_mwh)} MWh`} />
              <Stat k="Delivered to Market 2" v={`${num(r.markets.delivered_market_2_mwh)} MWh`} />
              <Stat k="Selling periods a day" v={num(r.markets.selling_periods_per_day)} n={`buying ${num(r.markets.buying_periods_per_day)}`} />
            </div>
          </div>
        </div>
      </section>

      <section className="section" id={id("cycles")}>
        <h2>Cycles and wear</h2>
        <p className="section-lede">
          {num(r.cycles.used, r.cycles.used < 100 ? 1 : 0)} of {num(r.cycles.budget)} cycles spent. Against the cycle life pro-rated to this horizon ({num(r.cycles.prorated_budget, r.cycles.prorated_budget < 100 ? 1 : 0)}),{" "}
          {r.cycles.prorated_crossed_at ? `the plan crossed it on ${day(r.cycles.prorated_crossed_at)}.` : "the plan stayed inside it."}
        </p>
        <div className="figs">
          <Figure
            title="Cycles spent against both budgets"
            result={r}
            build={cyclesBuild}
            height={280}
            label="Cumulative equivalent full cycles against the budget and the pro-rated budget"
            available={hasData(d.cycles_cumulative)}
            controls={
              <div className="segmented" role="group" aria-label="Vertical scale">
                <button type="button" aria-pressed={budgetScale} onClick={() => setBudgetScale(true)}>
                  Budget
                </button>
                <button type="button" aria-pressed={!budgetScale} onClick={() => setBudgetScale(false)}>
                  Data
                </button>
              </div>
            }
          />
        </div>
        <div className="figs figs-2">
          <Figure title="Cycles in a day" result={r} build={charts.dailyCyclesHistogram} height={260} label="Histogram of cycles spent per day" available={hasData(d.cycles)} />
          <Figure title="Usable volume after degradation (§4.7)" note={`${num(r.cycles.volume_lost_mwh, 4)} MWh lost of ${num(r.battery.volume_mwh, 2)}.`} result={r} build={charts.usableVolume} height={260} label="Usable storage volume by day" available={hasData(d.usable_volume_mwh)} />
        </div>
        <div className="facts">
          <Stat k="Volume lost" v={`${num(r.cycles.volume_lost_mwh, 4)} MWh`} n={`${num(r.headline.degradation_pct, 3)}% of nominal`} />
          <Stat k="Realised margin" v={isNum(r.cycles.realised_margin_gbp_per_mwh) ? `£${num(r.cycles.realised_margin_gbp_per_mwh, 2)}/MWh` : "n/a"} />
          <Stat k="Trading forgone to wear" v={gbp(r.cycles.forgone_per_year_gbp)} n="per year, at that margin" />
          <Stat k="Stored at the end" v={`${num(r.headline.final_storage_mwh, 2)} MWh`} />
        </div>
      </section>

      <section className="section" id={id("spread")}>
        <h2>Is profit tracking the spread, or the price level?</h2>
        <p className="section-lede">The battery is paid for differences between prices, not for their level. One point per day.</p>
        <div className="figs figs-2">
          <Figure title="Profit against the day's harvestable spread" note={fitLabel("harvestable_spread")} result={r} build={harvestScatter} height={300} label="Daily profit against the harvestable spread, with a least-squares line" available={hasData(d.harvestable_spread) && hasData(d.profit_gbp)} />
          <Figure title="Profit against the day's mean price" note={fitLabel("mean_price")} result={r} build={levelScatter} height={300} label="Daily profit against the mean price, with a least-squares line" available={hasData(d.mean_price) && hasData(d.profit_gbp)} />
        </div>
        <div className="figs figs-3">
          <SpreadTable r={r} />
          <Figure
            title="The level and the spread, by quarter"
            note="Each relative to the first quarter."
            result={r}
            build={charts.quarterlyLevelAndSpread}
            height={260}
            label="Quarterly mean price and harvestable spread, relative to the first quarter"
            available={r.series.quarterly.quarter.length > 1}
            empty="One quarter only: nothing to compare it with."
          />
        </div>
      </section>

      <section className="section" id={id("yardstick")}>
        <h2>Against a yardstick, and the costs left out</h2>
        <p className="section-lede">
          The yardstick is one perfect cycle of the {num(r.yardstick.volume_mwh, 1)} MWh volume a day, bought at the day&apos;s floor and sold at its ceiling. It ignores the rate limits, the hourly commitment and the cycle cap, so it is a scale, not a bound. The plan falls short of it on {num(r.yardstick.days_below)} of {num(r.yardstick.days)} days.
        </p>
        <div className="figs figs-3">
          <Figure title="Day by day against one ideal cycle" note="Points above the dashed line beat it." result={r} build={charts.yardstickScatter} height={300} label="Daily profit against the one-ideal-cycle yardstick" available={hasData(d.yardstick_gbp)} />
          <Figure title="The edge, year by year" note="The plan over the yardstick on the median day." result={r} build={charts.yardstickByYear} height={300} label="Median daily ratio of plan to yardstick by year" available={hasData(r.series.yearly.yardstick_median_ratio)} />
        </div>
        <div className="facts">
          <Stat k="Trading profit" v={gbp(r.headline.profit_gbp)} />
          <Stat k={`Capex and ${num(r.costs.years, r.costs.years < 1 ? 2 : 1)} years of fixed opex`} v={gbp(r.costs.total_gbp)} n={`${gbpShort(r.costs.capex_gbp)} + ${gbpShort(r.costs.fixed_opex_gbp)}`} />
          <Stat k={r.costs.shortfall_gbp > 0 ? "Short of paying for itself by" : "Ahead of its costs by"} v={gbp(Math.abs(r.costs.shortfall_gbp))} n="Costs do not enter the dispatch: context only." />
        </div>
      </section>
    </div>
  );
}
