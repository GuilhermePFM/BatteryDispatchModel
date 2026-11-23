// The investment section of a result: the financial inputs and everything they
// move. All of it runs in the browser (model.md §8), so a change here needs no
// new solve and no sign-in.
import { WarningCircle } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Chart } from "../charts/Chart";
import { cashFlowChart } from "../charts/options";
import { usePalette } from "../charts/theme";
import type { BusinessCase, Result, Submarket } from "../contracts/types";
import {
  defaultForm,
  INVESTMENT_FIELDS,
  MACRO_FIELDS,
  OPENING_PRICE,
  PRODUCT_LABEL,
  TAX_FIELDS,
  toInputs,
  validateForm,
  type FinanceErrors,
  type FinanceField,
  type FinanceForm,
  type Product,
  type Provenance,
  type RevenueBasis,
} from "../finance/defaults";
import { evaluateContracted, evaluateMerchant, realDiscountRate, type FinanceInputs } from "../finance/model";
import { evaluatePortfolio, sensitivity, type SubmarketView } from "../finance/portfolio";
import { brl, brlShort, num, pct } from "../lib/format";

const PROVENANCE: Record<Provenance, string> = {
  contract: "contract",
  client: "your input",
  measured: "measured",
  assumption: "assumption",
};

const years = (value: number | null) => (value === null ? "never" : `year ${value}`);

function Stat({ k, v, n }: { k: string; v: string; n?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {n ? <div className="n">{n}</div> : null}
    </div>
  );
}

function Field({ field, value, error, onChange }: { field: FinanceField; value: string; error?: string; onChange: (value: string) => void }) {
  const id = `fin-${field.key}`;
  return (
    <div className="field">
      <label htmlFor={id}>
        <span>
          {field.label} <span className="tag">{PROVENANCE[field.provenance]}</span>
        </span>
        <span className="unit">{field.unit}</span>
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <span className="error-text" id={`${id}-help`}>
          {error}
        </span>
      ) : (
        <span className="help" id={`${id}-help`}>
          {field.help}
        </span>
      )}
    </div>
  );
}

function Comparison({ views, selected, onSelect }: { views: SubmarketView[]; selected: Submarket; onSelect: (s: Submarket) => void }) {
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Submarket</th>
            <th>Merchant NPV</th>
            <th>Merchant IRR</th>
            <th>Max capex</th>
            <th>Behind the best</th>
            <th>Contracted NPV</th>
            <th>Contracted IRR</th>
            <th>Lowest viable bid</th>
          </tr>
        </thead>
        <tbody>
          {views.map((v) => (
            <tr key={v.submarket} aria-selected={v.submarket === selected}>
              <td>{v.rank}</td>
              <td>
                <button type="button" className="btn btn-quiet btn-sm" aria-pressed={v.submarket === selected} onClick={() => onSelect(v.submarket)}>
                  {v.submarket}
                </button>
              </td>
              <td>{brlShort(v.merchant.npv)}</td>
              <td>{pct(v.merchant.irr)}</td>
              <td>{brlShort(v.merchantMaxCapex)}</td>
              <td>{v.regret > 0 ? brlShort(v.regret) : "best"}</td>
              <td>{v.contracted ? brlShort(v.contracted.npv) : "not eligible"}</td>
              <td>{v.contracted ? pct(v.contracted.irr) : "n/a"}</td>
              <td>{v.contracted ? brl(v.minBid) : "n/a"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Investment({ result, runMonth }: { result: Result; runMonth?: string }) {
  const palette = usePalette();
  const [product, setProduct] = useState<Product>("A");
  const [form, setForm] = useState<FinanceForm>(() => defaultForm("A"));
  // What the figures show: the last form with no errors, so a half-typed number does not blank them.
  const [applied, setApplied] = useState<FinanceForm>(form);
  const [basis, setBasis] = useState<RevenueBasis>("balanced");
  const [chosen, setChosen] = useState<Submarket | null>(null);
  const [business, setBusiness] = useState<BusinessCase>("merchant");
  const errors: FinanceErrors = useMemo(() => validateForm(form), [form]);

  function update(next: FinanceForm) {
    setForm(next);
    if (Object.keys(validateForm(next)).length === 0) setApplied(next);
  }

  function chooseProduct(next: Product) {
    // A bid still at the old opening price follows the product.
    if (form.bid.trim() === String(OPENING_PRICE[product])) update({ ...form, bid: String(OPENING_PRICE[next]) });
    setProduct(next);
  }

  const { inputs, captureOverride } = useMemo(() => toInputs(applied, result.battery.power_mw, runMonth), [applied, result.battery.power_mw, runMonth]);
  const views = useMemo(() => evaluatePortfolio(result, inputs, { captureOverride, basis }), [result, inputs, captureOverride, basis]);
  const eligible = result.eligibility.contract_eligible;
  const shown = eligible ? business : "merchant";
  const view = views.find((v) => v.submarket === chosen) ?? views[0];
  const evaluation = shown === "contracted" && view.contracted ? view.contracted : view.merchant;
  const withCapture: FinanceInputs = useMemo(() => ({ ...inputs, captureFactor: view.captureFactor }), [inputs, view.captureFactor]);
  const rows = useMemo(() => {
    if (shown === "contracted" && view.physicalContracted && view.reimbursement !== null) {
      const physical = view.physicalContracted;
      const owed = view.reimbursement;
      return sensitivity(withCapture, (next) => evaluateContracted(next, physical, owed), "contracted");
    }
    return sensitivity(withCapture, (next) => evaluateMerchant(next, view.physicalMerchant, view.merchantRevenue), "merchant");
  }, [shown, view, withCapture]);
  const chart = useMemo(() => cashFlowChart(evaluation.flows, evaluation.capexPaid, palette), [evaluation, palette]);
  const opening = OPENING_PRICE[product];
  const invalid = Object.keys(errors).length > 0;
  const noMargin = view.contracted !== null && view.contracted.replacements.length >= 10;

  const fieldset = (legend: string, note: string, fields: FinanceField[]) => (
    <fieldset className="group">
      <legend>{legend}</legend>
      <p className="group-note">{note}</p>
      <div className="fields">
        {fields.map((field) => (
          <Field key={field.key} field={field} value={form[field.key]} error={errors[field.key]} onChange={(value) => update({ ...form, [field.key]: value })} />
        ))}
      </div>
    </fieldset>
  );

  return (
    <>
      {result.eligibility.below_minimum_power ? (
        <div className="banner" role="status">
          <WarningCircle size={18} aria-hidden="true" />
          <span>
            Under {num(result.eligibility.minimum_power_mw)} MW this project cannot enter the auction. The contracted figures show what the contract would pay at this size.
          </span>
        </div>
      ) : null}
      {!eligible ? (
        <div className="banner" role="status">
          <WarningCircle size={18} aria-hidden="true" />
          <span>
            The contracted case was not solved: the battery {result.eligibility.contract_shortfalls.join("; ")}. The merchant case is unaffected.
          </span>
        </div>
      ) : null}

      <div className="headline">
        <div className="headline-main">
          <div className="label">Best submarket, by merchant NPV</div>
          <div className="big">{views[0].submarket}</div>
          <p className="sub">
            Merchant NPV {brl(views[0].merchant.npv)} at a {pct(inputs.discountRate)} nominal rate ({pct(realDiscountRate(inputs.discountRate, inputs.ipca))} real). The merchant revenue is a perfect-foresight ceiling scaled by a measured capture factor.
          </p>
        </div>
        <div className="stats">
          <Stat k="Merchant IRR" v={pct(views[0].merchant.irr)} n={`payback ${years(views[0].merchant.payback)}`} />
          <Stat k="Contracted NPV" v={views[0].contracted ? brlShort(views[0].contracted.npv) : "n/a"} n="No material locational difference" />
          <Stat k="Lowest viable bid" v={views[0].contracted ? brl(views[0].minBid) : "n/a"} n={`per MW-year; opening price ${brl(opening)}`} />
        </div>
      </div>

      <section className="section" id="compare">
        <h2>Contracted against merchant, by submarket</h2>
        <p className="section-lede">
          Submarkets are ranked by the merchant case. The contracted revenue is the same everywhere, so differences between submarkets there come only from the dispatch proxy and the reimbursement. Select a submarket to see its flows.
        </p>
        <Comparison views={views} selected={view.submarket} onSelect={setChosen} />
      </section>

      <section className="section" id="inputs">
        <h2>Financial inputs</h2>
        <p className="section-lede">
          These run in your browser: nothing here starts a solve or counts against your runs. Inputs tagged <span className="tag">assumption</span> have no market source and are yours to replace.
        </p>
        {invalid ? (
          <div className="banner error" role="alert">
            <WarningCircle size={18} aria-hidden="true" />
            <span>The figures keep the last valid inputs until the highlighted fields are fixed.</span>
          </div>
        ) : null}
        <div className="actions" style={{ marginBottom: 16 }}>
          <div className="segmented" role="group" aria-label="Auction product">
            {(["A", "B"] as Product[]).map((p) => (
              <button key={p} type="button" aria-pressed={product === p} title={PRODUCT_LABEL[p]} onClick={() => chooseProduct(p)}>
                Product {p}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Revenue basis">
            <button type="button" aria-pressed={basis === "balanced"} onClick={() => setBasis("balanced")}>
              Balanced year
            </button>
            <button type="button" aria-pressed={basis === "last12"} onClick={() => setBasis("last12")}>
              Last 12 months
            </button>
          </div>
        </div>
        {fieldset("Macro", "DI (B3) and NTN-B (Tesouro Nacional) are the usual references for a discount rate. Check their current levels at the source.", MACRO_FIELDS)}
        {fieldset("Investment", "Revenue, costs and capacity over the 15 contract years.", INVESTMENT_FIELDS)}
        {fieldset("Tax and allowances", "Applied to both cases, except the penalty allowance.", TAX_FIELDS)}
      </section>

      <section className="section" id="flows">
        <h2>
          {view.submarket}, {shown}
        </h2>
        {eligible ? (
          <div className="segmented" role="group" aria-label="Business case" style={{ marginBottom: 16 }}>
            <button type="button" aria-pressed={shown === "merchant"} onClick={() => setBusiness("merchant")}>
              Merchant
            </button>
            <button type="button" aria-pressed={shown === "contracted"} onClick={() => setBusiness("contracted")}>
              Contracted
            </button>
          </div>
        ) : null}
        {shown === "contracted" && noMargin ? (
          <div className="banner" role="status">
            <WarningCircle size={18} aria-hidden="true" />
            <span>
              This battery has almost no margin over the 4 h the contract requires, so fade forces new modules in {num(view.contracted?.replacements.length)} of 15 years (CRCAP 7.7.1). Size it above 4 h on the run form to see the trade-off.
            </span>
          </div>
        ) : null}
        <div className="facts">
          <Stat k="NPV" v={brl(evaluation.npv)} />
          <Stat k="IRR" v={evaluation.irr === null ? "no single rate" : pct(evaluation.irr)} />
          <Stat k="Payback" v={years(evaluation.payback)} n={`discounted: ${years(evaluation.discountedPayback)}`} />
          <Stat k="Max viable capex" v={brlShort(shown === "contracted" ? view.contractedMaxCapex : view.merchantMaxCapex)} />
          <Stat
            k={shown === "contracted" ? "Module additions" : "Replacements"}
            v={num(evaluation.replacements.length)}
            n={evaluation.replacements.length ? `${pct(evaluation.replacementShares.reduce((total, share) => total + share, 0))} of the volume, years ${evaluation.replacements.join(", ")}` : "none"}
          />
          {shown === "contracted" ? (
            <Stat k="Reimbursement base" v={brlShort(view.reimbursement)} n="CRCAP 8.1, per year at May 2026" />
          ) : (
            <Stat k="Revenue base" v={brlShort(view.merchantRevenue)} n={`per year at May 2026, capture ${num(view.captureFactor, 3)}`} />
          )}
        </div>
        <div className="figs">
          <figure className="fig" style={{ margin: 0 }}>
            <div className="fig-head">
              <div>
                <h3>Cash flows</h3>
                <p className="fig-note">Nominal BRL at each contract year end, after tax. Year 0 is the capex, indexed to August 2028.</p>
              </div>
            </div>
            <Chart option={chart} height={300} label="Yearly cash flows and their cumulative position" />
          </figure>
        </div>
        <div className="figs">
          <div className="fig">
            <h3>What moves the NPV</h3>
            <p className="fig-note">One input at a time, around the current values.</p>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Input</th>
                    <th>Low</th>
                    <th>NPV at low</th>
                    <th>High</th>
                    <th>NPV at high</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.label}>
                      <td>{row.label}</td>
                      <td>{row.low}</td>
                      <td>{brlShort(row.npvLow)}</td>
                      <td>{row.high}</td>
                      <td>{brlShort(row.npvHigh)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        {shown === "contracted" ? (
          <p className="help">
            Not in these flows, and worth pricing as risk: delay penalties (CRCAP 6.8), dispatch deviation penalties at 1.15 times the unit fixed revenue (9.2, 9.3), declared availability penalties at 1.1 times (9.4), scheduled unavailability above 2.5% a year (5.7.3) and the termination fine of three times the annual fixed revenue (13.1).
          </p>
        ) : null}
      </section>
    </>
  );
}
