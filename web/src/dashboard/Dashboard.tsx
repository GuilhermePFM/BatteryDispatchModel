// The results page of a run, driven by the v2 result payload alone
// (contracts/v2/result.schema.json): the investment decision first, then the
// dispatch behind it.
import { hasData } from "../charts/adapters";
import { Figure } from "../charts/Figure";
import * as charts from "../charts/options";
import type { Palette } from "../charts/theme";
import type { Result } from "../contracts/types";
import { brl, day, num, pct } from "../lib/format";
import { Investment } from "./Investment";

const SECTIONS = [
  ["compare", "Compare"],
  ["inputs", "Inputs"],
  ["flows", "Cash flows"],
  ["prices", "Prices"],
  ["dispatch", "Dispatch"],
  ["cycles", "Cycles"],
] as const;

const weekFull = (r: Result, p: Palette) => charts.week(r, p);

export function Dashboard({ result: r, runMonth }: { result: Result; runMonth?: string }) {
  const d = r.detail.daily;
  const w = r.detail.week;
  const shownCase = charts.detailCase(r);
  const weekSpan = w.hora.length ? `${day(w.hora[0])} to ${day(w.hora[w.hora.length - 1])}` : "";

  return (
    <div className="dash">
      <nav className="toc" aria-label="Dashboard sections">
        {SECTIONS.map(([key, label]) => (
          <a key={key} href={`#${key}`}>
            {label}
          </a>
        ))}
      </nav>

      {/* Keyed by the run, so another run's result starts from the default inputs. */}
      <Investment key={`${r.horizon.start}-${r.horizon.end}-${r.battery.power_mw}-${r.battery.volume_mwh}`} result={r} runMonth={runMonth} />

      <section className="section" id="prices">
        <h2>The PLD it was handed</h2>
        <p className="section-lede">
          {r.detail.submarket}, {num(r.horizon.days)} days, {day(r.horizon.start)} to {day(r.horizon.end)}. At a {pct(r.battery.round_trip_efficiency, 0)} round trip, a sale has to beat its purchase by{" "}
          {pct(1 / r.battery.round_trip_efficiency - 1)} before a trade pays.
        </p>
        <div className="figs">
          <Figure title="The day's range and mean" note="Drag or scroll to zoom." result={r} build={charts.dailyPriceBand} height={300} label="Daily minimum, mean and maximum PLD" available={hasData(d.price_max)} />
        </div>
        <div className="figs figs-2">
          <Figure title="The shape the battery trades against" note="Mean PLD by local hour." result={r} build={charts.priceProfile} height={260} label="Mean PLD by hour of the day" available={hasData(r.detail.profile.price)} />
          <Figure title="Merchant value by submarket" note="Balanced year, nominal, before the capture factor." result={r} build={charts.rankingBars} height={260} label="Balanced-year merchant value per submarket" available={r.ranking.length > 0} />
        </div>
      </section>

      <section className="section" id="dispatch">
        <h2>What the plan does</h2>
        <p className="section-lede">
          The {r.detail.case} dispatch of {r.detail.submarket}. Above the line is energy delivered, below it energy bought. This is a perfect-foresight plan and the value it shows is nominal.
        </p>
        <div className="figs">
          <Figure title="A typical week, hour by hour" note={`${weekSpan}: the seven days whose value is the median of every run of seven. Scroll on the chart to zoom.`} result={r} build={weekFull} height={520} label="PLD, power and storage over a representative week" available={w.hora.length > 0} />
          <Figure title="Every day at once: net power" note="A column per day, a row per hour. Orange is delivering, blue charging." result={r} build={charts.netPowerHeatmap} height={340} label="Heatmap of net power by day and hour" available={r.detail.net_power.date.length > 0} />
        </div>
        <div className="figs figs-3">
          <Figure title="Cumulative value" note="Drag or scroll to zoom." result={r} build={charts.cumulativeValue} height={280} label="Cumulative dispatch value by day" available={hasData(d.value_brl)} />
          <Figure title="Value by month" result={r} build={charts.monthlyValue} height={280} label="Dispatch value by calendar month" available={Boolean(shownCase?.monthly.month.length)} />
        </div>
        <div className="figs">
          <Figure title="When the battery works" note="Mean power by local hour." result={r} build={charts.profilePower} height={280} label="Mean charging and delivering power by hour" available={hasData(r.detail.profile.charge_mw)} />
        </div>
      </section>

      <section className="section" id="cycles">
        <h2>Cycles and wear</h2>
        <p className="section-lede">
          The contract allows two cycles a day and 366 in any twelve months. {shownCase ? `This plan spends ${num(shownCase.cycles_per_year, 0)} physical cycles in a balanced year.` : ""}
        </p>
        <div className="figs figs-2">
          <Figure title="Cycles in a day" result={r} build={charts.dailyCyclesHistogram} height={260} label="Histogram of cycles spent per day" available={hasData(d.cycles)} />
          <div className="fig">
            <h3>The solved cases</h3>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Balanced year</th>
                    <th>Cycles / year</th>
                    <th>Max h / day</th>
                    <th>Method</th>
                  </tr>
                </thead>
                <tbody>
                  {r.cases.map((c) => (
                    <tr key={`${c.submarket}-${c.case}`}>
                      <td>
                        {c.submarket}, {c.case}
                      </td>
                      <td>{brl(c.balanced_year_brl)}</td>
                      <td>{num(c.cycles_per_year, 0)}</td>
                      <td>{num(c.max_injection_hours)}</td>
                      <td>{c.method}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
