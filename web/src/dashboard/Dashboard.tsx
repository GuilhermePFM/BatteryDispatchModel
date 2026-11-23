// The results page of a run, driven by the v2 result payload alone
// (contracts/v2/result.schema.json): the investment decision first, then the
// dispatch behind it.
import { hasData } from "../charts/adapters";
import { Figure } from "../charts/Figure";
import * as charts from "../charts/options";
import type { Palette } from "../charts/theme";
import type { Result } from "../contracts/types";
import { useI18n } from "../i18n";
import { brl, day, num, pct } from "../lib/format";
import { Investment } from "./Investment";

const SECTIONS = ["compare", "inputs", "flows", "prices", "dispatch", "cycles"] as const;

const weekFull = (r: Result, p: Palette) => charts.week(r, p);

export function Dashboard({ result: r, runMonth }: { result: Result; runMonth?: string }) {
  const { t: all } = useI18n();
  const t = all.dashboard;
  const d = r.detail.daily;
  const w = r.detail.week;
  const shownCase = charts.detailCase(r);
  const weekSpan = w.hora.length ? all.common.range(day(w.hora[0]), day(w.hora[w.hora.length - 1])) : "";

  return (
    <div className="dash">
      <nav className="toc" aria-label={t.sectionsNav}>
        {SECTIONS.map((key) => (
          <a key={key} href={`#${key}`}>
            {t.sections[key]}
          </a>
        ))}
      </nav>

      {/* Keyed by the run, so another run's result starts from the default inputs. */}
      <Investment key={`${r.horizon.start}-${r.horizon.end}-${r.battery.power_mw}-${r.battery.volume_mwh}`} result={r} runMonth={runMonth} />

      <section className="section" id="prices">
        <h2>{t.pricesTitle}</h2>
        <p className="section-lede">
          {t.pricesLede(r.detail.submarket, num(r.horizon.days), day(r.horizon.start), day(r.horizon.end), pct(r.battery.round_trip_efficiency, 0), pct(1 / r.battery.round_trip_efficiency - 1))}
        </p>
        <div className="figs">
          <Figure title={t.bandTitle} note={t.dragZoom} result={r} build={charts.dailyPriceBand} height={300} label={t.bandLabel} available={hasData(d.price_max)} />
        </div>
        <div className="figs figs-2">
          <Figure title={t.shapeTitle} note={t.shapeNote} result={r} build={charts.priceProfile} height={260} label={t.shapeLabel} available={hasData(r.detail.profile.price)} />
          <Figure title={t.rankingTitle} note={t.rankingNote} result={r} build={charts.rankingBars} height={260} label={t.rankingLabel} available={r.ranking.length > 0} />
        </div>
      </section>

      <section className="section" id="dispatch">
        <h2>{t.dispatchTitle}</h2>
        <p className="section-lede">{t.dispatchLede(all.common.cases[r.detail.case], r.detail.submarket)}</p>
        <div className="figs">
          <Figure title={t.weekTitle} note={t.weekNote(weekSpan)} result={r} build={weekFull} height={520} label={t.weekLabel} available={w.hora.length > 0} />
          <Figure title={t.heatTitle} note={t.heatNote} result={r} build={charts.netPowerHeatmap} height={340} label={t.heatLabel} available={r.detail.net_power.date.length > 0} />
        </div>
        <div className="figs figs-3">
          <Figure title={t.cumulativeTitle} note={t.dragZoom} result={r} build={charts.cumulativeValue} height={280} label={t.cumulativeLabel} available={hasData(d.value_brl)} />
          <Figure title={t.monthlyTitle} result={r} build={charts.monthlyValue} height={280} label={t.monthlyLabel} available={Boolean(shownCase?.monthly.month.length)} />
        </div>
        <div className="figs">
          <Figure title={t.worksTitle} note={t.worksNote} result={r} build={charts.profilePower} height={280} label={t.worksLabel} available={hasData(r.detail.profile.charge_mw)} />
        </div>
      </section>

      <section className="section" id="cycles">
        <h2>{t.cyclesTitle}</h2>
        <p className="section-lede">
          {t.cyclesLede}
          {shownCase ? t.cyclesPlan(num(shownCase.cycles_per_year, 0)) : ""}
        </p>
        <div className="figs figs-2">
          <Figure title={t.histogramTitle} result={r} build={charts.dailyCyclesHistogram} height={260} label={t.histogramLabel} available={hasData(d.cycles)} />
          <div className="fig">
            <h3>{t.casesTitle}</h3>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t.caseColumn}</th>
                    <th>{t.balancedYear}</th>
                    <th>{t.cyclesYear}</th>
                    <th>{t.maxHours}</th>
                    <th>{t.methodColumn}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.cases.map((c) => (
                    <tr key={`${c.submarket}-${c.case}`}>
                      <td>
                        {c.submarket}, {all.common.cases[c.case]}
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
