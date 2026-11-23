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
  TAX_FIELDS,
  toInputs,
  validateForm,
  type FinanceErrors,
  type FinanceField,
  type FinanceForm,
  type Product,
  type RevenueBasis,
} from "../finance/defaults";
import { evaluateContracted, evaluateMerchant, realDiscountRate, type FinanceInputs } from "../finance/model";
import { evaluatePortfolio, sensitivity, type SubmarketView } from "../finance/portfolio";
import { messages, useI18n } from "../i18n";
import { Rich } from "../i18n/Rich";
import { localizeServerMessage } from "../i18n/server";
import { brl, brlShort, num, pct } from "../lib/format";

const years = (value: number | null) => (value === null ? messages().investment.never : messages().investment.year(value));

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
  const { t } = useI18n();
  const id = `fin-${field.key}`;
  return (
    <div className="field">
      <label htmlFor={id}>
        <span>
          {field.label} <span className="tag">{t.finance.provenance[field.provenance]}</span>
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
  const { t: all } = useI18n();
  const t = all.investment;
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>{t.rank}</th>
            <th>{t.submarket}</th>
            <th>{t.merchantNpv}</th>
            <th>{t.merchantIrr}</th>
            <th>{t.maxCapex}</th>
            <th>{t.behindBest}</th>
            <th>{t.contractedNpv}</th>
            <th>{t.contractedIrr}</th>
            <th>{t.lowestBid}</th>
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
              <td>{v.regret > 0 ? brlShort(v.regret) : t.best}</td>
              <td>{v.contracted ? brlShort(v.contracted.npv) : t.notEligible}</td>
              <td>{v.contracted ? pct(v.contracted.irr) : all.common.na}</td>
              <td>{v.contracted ? brl(v.minBid) : all.common.na}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Investment({ result, runMonth }: { result: Result; runMonth?: string }) {
  const { locale, t: all } = useI18n();
  const t = all.investment;
  const palette = usePalette();
  const [product, setProduct] = useState<Product>("A");
  const [form, setForm] = useState<FinanceForm>(() => defaultForm("A"));
  // What the figures show: the last form with no errors, so a half-typed number does not blank them.
  const [applied, setApplied] = useState<FinanceForm>(form);
  const [basis, setBasis] = useState<RevenueBasis>("balanced");
  const [chosen, setChosen] = useState<Submarket | null>(null);
  const [business, setBusiness] = useState<BusinessCase>("merchant");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- what it builds reads the active language
  const errors: FinanceErrors = useMemo(() => validateForm(form), [form, locale]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- what it builds reads the active language
  }, [shown, view, withCapture, locale]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- what it builds reads the active language
  const chart = useMemo(() => cashFlowChart(evaluation.flows, evaluation.capexPaid, palette), [evaluation, palette, locale]);
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
          <span>{t.belowMinimum(num(result.eligibility.minimum_power_mw))}</span>
        </div>
      ) : null}
      {!eligible ? (
        <div className="banner" role="status">
          <WarningCircle size={18} aria-hidden="true" />
          <span>{t.notSolved(result.eligibility.contract_shortfalls.map(localizeServerMessage).join("; "))}</span>
        </div>
      ) : null}

      <div className="headline">
        <div className="headline-main">
          <div className="label">{t.bestLabel}</div>
          <div className="big">{views[0].submarket}</div>
          <p className="sub">{t.headline(brl(views[0].merchant.npv), pct(inputs.discountRate), pct(realDiscountRate(inputs.discountRate, inputs.ipca)))}</p>
        </div>
        <div className="stats">
          <Stat k={t.merchantIrr} v={pct(views[0].merchant.irr)} n={t.payback(years(views[0].merchant.payback))} />
          <Stat k={t.contractedNpv} v={views[0].contracted ? brlShort(views[0].contracted.npv) : all.common.na} n={t.noLocational} />
          <Stat k={t.lowestBid} v={views[0].contracted ? brl(views[0].minBid) : all.common.na} n={t.bidNote(brl(opening))} />
        </div>
      </div>

      <section className="section" id="compare">
        <h2>{t.compareTitle}</h2>
        <p className="section-lede">{t.compareLede}</p>
        <Comparison views={views} selected={view.submarket} onSelect={setChosen} />
      </section>

      <section className="section" id="inputs">
        <h2>{t.inputsTitle}</h2>
        <p className="section-lede">
          <Rich text={t.inputsLede} tags={{ tag: (text) => <span className="tag">{text}</span> }} />
        </p>
        {invalid ? (
          <div className="banner error" role="alert">
            <WarningCircle size={18} aria-hidden="true" />
            <span>{t.keepValid}</span>
          </div>
        ) : null}
        <div className="actions" style={{ marginBottom: 16 }}>
          <div className="segmented" role="group" aria-label={t.auctionProduct}>
            {(["A", "B"] as Product[]).map((p) => (
              <button key={p} type="button" aria-pressed={product === p} title={all.finance.products[p]} onClick={() => chooseProduct(p)}>
                {t.product(p)}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label={t.revenueBasis}>
            <button type="button" aria-pressed={basis === "balanced"} onClick={() => setBasis("balanced")}>
              {t.balancedYear}
            </button>
            <button type="button" aria-pressed={basis === "last12"} onClick={() => setBasis("last12")}>
              {t.last12}
            </button>
          </div>
        </div>
        {fieldset(t.macro, t.macroNote, MACRO_FIELDS)}
        {fieldset(t.investment, t.investmentNote, INVESTMENT_FIELDS)}
        {fieldset(t.tax, t.taxNote, TAX_FIELDS)}
      </section>

      <section className="section" id="flows">
        <h2>
          {view.submarket}, {all.common.cases[shown]}
        </h2>
        {eligible ? (
          <div className="segmented" role="group" aria-label={t.businessCase} style={{ marginBottom: 16 }}>
            <button type="button" aria-pressed={shown === "merchant"} onClick={() => setBusiness("merchant")}>
              {t.merchant}
            </button>
            <button type="button" aria-pressed={shown === "contracted"} onClick={() => setBusiness("contracted")}>
              {t.contracted}
            </button>
          </div>
        ) : null}
        {shown === "contracted" && noMargin ? (
          <div className="banner" role="status">
            <WarningCircle size={18} aria-hidden="true" />
            <span>{t.noMargin(num(view.contracted?.replacements.length))}</span>
          </div>
        ) : null}
        <div className="facts">
          <Stat k={t.npv} v={brl(evaluation.npv)} />
          <Stat k={t.irr} v={evaluation.irr === null ? t.noSingleRate : pct(evaluation.irr)} />
          <Stat k={t.paybackLabel} v={years(evaluation.payback)} n={t.discounted(years(evaluation.discountedPayback))} />
          <Stat k={t.maxViableCapex} v={brlShort(shown === "contracted" ? view.contractedMaxCapex : view.merchantMaxCapex)} />
          <Stat
            k={shown === "contracted" ? t.moduleAdditions : t.replacements}
            v={num(evaluation.replacements.length)}
            n={evaluation.replacements.length ? t.replacementNote(pct(evaluation.replacementShares.reduce((total, share) => total + share, 0)), evaluation.replacements.join(", ")) : t.none}
          />
          {shown === "contracted" ? (
            <Stat k={t.reimbursementBase} v={brlShort(view.reimbursement)} n={t.reimbursementNote} />
          ) : (
            <Stat k={t.revenueBase} v={brlShort(view.merchantRevenue)} n={t.revenueNote(num(view.captureFactor, 3))} />
          )}
        </div>
        <div className="figs">
          <figure className="fig" style={{ margin: 0 }}>
            <div className="fig-head">
              <div>
                <h3>{t.cashFlows}</h3>
                <p className="fig-note">{t.cashFlowsNote}</p>
              </div>
            </div>
            <Chart option={chart} height={300} label={t.cashFlowsLabel} />
          </figure>
        </div>
        <div className="figs">
          <div className="fig">
            <h3>{t.movesTitle}</h3>
            <p className="fig-note">{t.movesNote}</p>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t.input}</th>
                    <th>{t.low}</th>
                    <th>{t.npvLow}</th>
                    <th>{t.high}</th>
                    <th>{t.npvHigh}</th>
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
          <p className="help">{t.risks}</p>
        ) : null}
      </section>
    </>
  );
}
