import { DownloadSimple, FileCsv, SignIn, WarningCircle, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import templateUrl from "../../../contracts/examples/pld-template.csv?url";
import { useAuth } from "../auth/AuthProvider";
import type { Me } from "../contracts/types";
import { intlLocale, useI18n } from "../i18n";
import { numberTag, Rich } from "../i18n/Rich";
import { localizeServerMessage } from "../i18n/server";
import { toNumber } from "../lib/decimal";
import { api, ApiError, describeError, uploadToPresigned } from "../lib/api";
import { day, num, pct } from "../lib/format";
import { sha256Hex } from "../lib/sha256";
import {
  automaticRates,
  BATTERY_FIELDS,
  BUNDLED_END,
  BUNDLED_START,
  buildRequest,
  contractWarnings,
  CYCLE_BUDGET_FIELD,
  defaultValues,
  HORIZON_FIELD,
  MAX_SPAN_DAYS,
  MAX_UPLOAD_BYTES,
  MIN_SPAN_DAYS,
  inspectPriceCsv,
  numberError,
  physicalBattery,
  roundTrip,
  spanDays,
  startForHorizon,
  validate,
  type FieldSpec,
  type FormErrors,
  type FormValues,
  type PriceFileInfo,
} from "../lib/validation";

/** The form survives a sign-in redirect and an "edit and retry" in sessionStorage. */
export const DRAFT_KEY = "batteryplan:draft";

function readDraft(): FormValues {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      const draft = JSON.parse(raw) as FormValues;
      const base = defaultValues();
      // A draft saved before the move to the PLD has none of these fields or dates.
      if (typeof draft.battery?.duration_hours !== "string") return base;
      return { ...base, ...draft, battery: { ...base.battery, ...draft.battery } };
    }
  } catch {
    // ignore a broken draft
  }
  return defaultValues();
}

function saveDraft(values: FormValues) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(values));
  } catch {
    // storage may be unavailable; the form still works
  }
}

const plain = (v: number) => v.toLocaleString(intlLocale(), { maximumFractionDigits: 6 });

interface NumberFieldProps {
  field: FieldSpec;
  name: string;
  value: string;
  error?: string;
  optional?: boolean;
  help?: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

function NumberField({ field, name, value, error, optional, help, placeholder, onChange }: NumberFieldProps) {
  const { t } = useI18n();
  const id = `f-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>
        <span>
          {field.label}
          {optional ? <span style={{ color: "var(--muted)", fontWeight: 400 }}> ({t.run.optional})</span> : null}
        </span>
        <span className="unit">{field.unit}</span>
      </label>
      <input
        id={id}
        name={name}
        type="text"
        inputMode={field.integer ? "numeric" : "decimal"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder ?? (optional ? t.run.noBudget : undefined)}
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
          {help ?? field.description} {t.run.between(plain(field.min), plain(field.max))}
        </span>
      )}
    </div>
  );
}

type Phase = "idle" | "hashing" | "uploading" | "sending";

export function Run() {
  const { locale, t: all } = useI18n();
  const t = all.run;
  const auth = useAuth();
  const navigate = useNavigate();
  const [values, setValues] = useState<FormValues>(readDraft);
  const [horizon, setHorizon] = useState(() => String(spanDays(values) ?? ""));
  const [touched, setTouched] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileInfo, setFileInfo] = useState<PriceFileInfo | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  // The error itself, so its text follows a change of language.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const errors: FormErrors = useMemo(() => {
    const found = validate(values, fileInfo);
    const horizonError = numberError(horizon, HORIZON_FIELD);
    return horizonError ? { ...found, horizon_days: horizonError } : found;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- what it builds reads the active language
  }, [values, fileInfo, horizon, locale]);
  const shown = touched ? errors : {};
  const valid = Object.keys(errors).length === 0;
  const rt = roundTrip(values);
  const span = spanDays(values);

  useEffect(() => saveDraft(values), [values]);

  const { token, dropSession } = auth;
  const refreshMe = useCallback(async () => {
    if (!token) return;
    try {
      setMe(await api.me(token));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) dropSession();
    }
  }, [token, dropSession]);
  useEffect(() => {
    let live = true;
    if (token) {
      api
        .me(token)
        .then((next) => live && setMe(next))
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 401) dropSession();
        });
    }
    return () => {
      live = false;
    };
  }, [token, dropSession]);
  const quota = token ? me : null;

  const setBattery = (key: string, value: string) =>
    setValues((v) => ({ ...v, battery: { ...v.battery, [key]: value } }));

  async function chooseFile(next: File | null) {
    setFile(next);
    setFailure(null);
    if (!next) {
      setFileInfo(null);
      return;
    }
    const data = next.size <= MAX_UPLOAD_BYTES ? new Uint8Array(await next.arrayBuffer()) : new Uint8Array();
    setFileInfo(inspectPriceCsv(next.name, next.size, data));
    setTouched(true);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) void chooseFile(dropped);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    if (!valid) {
      const first = document.querySelector<HTMLInputElement>("[aria-invalid='true']");
      first?.focus();
      return;
    }
    if (!auth.token) {
      saveDraft(values);
      auth.signIn("/run");
      return;
    }
    try {
      let pricesKey: string | undefined;
      if (file) {
        setPhase("hashing");
        const bytes = await file.arrayBuffer();
        const digest = await sha256Hex(bytes);
        setPhase("uploading");
        const ticket = await api.createUpload(auth.token, digest, file.size);
        await uploadToPresigned(ticket, new Blob([bytes], { type: "text/csv" }), file.name);
        pricesKey = ticket.prices_key;
      }
      setPhase("sending");
      const created = await api.createRun(auth.token, buildRequest(values, pricesKey));
      navigate(`/runs/${encodeURIComponent(created.run_id)}`, { state: { cached: created.cached } });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) auth.dropSession();
      setFailure({ error });
      void refreshMe();
    } finally {
      setPhase("idle");
    }
  }

  function onChangeDate(key: "start" | "end") {
    return (e: ChangeEvent<HTMLInputElement>) => {
      const next = { ...values, [key]: e.target.value };
      setValues(next);
      const days = spanDays(next);
      if (days !== null) setHorizon(String(days));
    };
  }

  function onChangeHorizon(text: string) {
    setHorizon(text);
    if (numberError(text, HORIZON_FIELD)) return;
    const start = startForHorizon(values.end, toNumber(text));
    if (start) setValues((v) => ({ ...v, start }));
  }

  const dateMin = fileInfo?.firstDay && !fileInfo.problem ? fileInfo.firstDay : BUNDLED_START;
  const dateMax = fileInfo?.lastDay && !fileInfo.problem ? fileInfo.lastDay : BUNDLED_END;
  const busy = phase !== "idle";
  const warnings = contractWarnings(values);
  const sized = errors["battery.power_mw"] || errors["battery.duration_hours"] || errors["battery.round_trip_efficiency"] || errors["battery.charge_rate_mw"] || errors["battery.discharge_rate_mw"] ? null : physicalBattery(values);
  const automatic = automaticRates(values);
  const shownFailure = failure ? describeError(failure.error) : null;
  const automaticMw = (key: string) => (key === "charge_rate_mw" ? automatic?.chargeMw : key === "discharge_rate_mw" ? automatic?.dischargeMw : undefined);

  return (
    <div className="page">
      <div className="wrap">
        <div className="page-head">
          <h1>{t.title}</h1>
          <p>{t.lede}</p>
        </div>

        <form className="run-layout" onSubmit={onSubmit} noValidate>
          <div>
            <fieldset className="group">
              <legend>{t.battery}</legend>
              <p className="group-note">{t.batteryNote}</p>
              <div className="fields">
                {BATTERY_FIELDS.map((field) => {
                  const auto = automaticMw(field.key);
                  return (
                    <NumberField
                      key={field.key}
                      field={auto === undefined ? field : { ...field, max: Math.min(field.max, auto) }}
                      name={field.key}
                      value={values.battery[field.key as keyof FormValues["battery"]]}
                      error={shown[`battery.${field.key}`]}
                      optional={field.optional}
                      placeholder={field.optional ? (auto === undefined ? t.automatic : t.automaticValue(num(auto, 2))) : undefined}
                      help={field.optional ? `${field.description} ${t.emptyFollows}` : undefined}
                      onChange={(v) => setBattery(field.key, v)}
                    />
                  );
                })}
              </div>
              <p className="derived">
                {rt ? <Rich text={t.derivedRoundTrip(pct(rt.efficiency, 2), pct(rt.markup, 2))} tags={numberTag} /> : t.derivedEmpty}
                {sized ? (
                  <Rich
                    text={t.derivedSize(
                      num(sized.volume_mwh, 1),
                      num(sized.max_charge_mw, 2),
                      num(sized.max_discharge_mw * sized.discharge_efficiency, 2),
                      num(sized.volume_mwh / (sized.charge_efficiency * sized.max_charge_mw), 2),
                    )}
                    tags={numberTag}
                  />
                ) : null}
              </p>
              {warnings.map((warning) => (
                <p className="help" key={warning}>
                  {warning} {t.merchantStillRuns}
                </p>
              ))}
            </fieldset>

            <fieldset className="group">
              <legend>{t.horizon}</legend>
              <p className="group-note">
                <Rich text={t.horizonNote(MIN_SPAN_DAYS + 1, MAX_SPAN_DAYS + 1)} tags={{ why: (text) => <Link to="/methodology#one-program-per-horizon">{text}</Link> }} />
              </p>
              <div className="fields">
                <div className="field">
                  <label htmlFor="f-start">
                    <span>{t.start}</span>
                    <span className="unit">{t.date}</span>
                  </label>
                  <input id="f-start" type="date" value={values.start} min={dateMin} max={dateMax} onChange={onChangeDate("start")} aria-invalid={shown.start ? true : undefined} />
                  {shown.start ? <span className="error-text">{shown.start}</span> : <span className="help">{t.from(day(dateMin))}</span>}
                </div>
                <NumberField field={HORIZON_FIELD} name="horizon_days" value={horizon} error={shown.horizon_days} onChange={onChangeHorizon} />
                <div className="field">
                  <label htmlFor="f-end">
                    <span>{t.end}</span>
                    <span className="unit">{t.dateInclusive}</span>
                  </label>
                  <input id="f-end" type="date" value={values.end} min={dateMin} max={dateMax} onChange={onChangeDate("end")} aria-invalid={shown.end ? true : undefined} />
                  {shown.end ? <span className="error-text">{shown.end}</span> : <span className="help">{span ? t.days(num(span)) : t.upTo(day(dateMax))}</span>}
                </div>
                <NumberField
                  field={CYCLE_BUDGET_FIELD}
                  name="cycle_budget"
                  value={values.cycle_budget}
                  error={shown.cycle_budget}
                  optional
                  onChange={(v) => setValues((s) => ({ ...s, cycle_budget: v }))}
                />
              </div>
            </fieldset>

            <fieldset className="group">
              <legend>{t.prices}</legend>
              <p className="group-note">
                <Rich text={t.pricesNote} tags={{ code: (text) => <code>{text}</code> }} />
              </p>
              <div
                className={`drop${dragging ? " dragging" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <div className="drop-row">
                  {file ? (
                    <span className="file-chip">
                      <FileCsv size={16} aria-hidden="true" />
                      {file.name}
                      <button
                        type="button"
                        className="btn-quiet"
                        style={{ border: 0, background: "none", cursor: "pointer", padding: 0, color: "inherit", display: "inline-flex" }}
                        aria-label={t.removeFile}
                        onClick={() => {
                          void chooseFile(null);
                          if (fileInput.current) fileInput.current.value = "";
                        }}
                      >
                        <X size={14} />
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileInput.current?.click()}>
                      <FileCsv size={16} aria-hidden="true" /> {t.chooseCsv}
                    </button>
                  )}
                  <a className="btn btn-quiet" href={templateUrl} download="pld-template.csv">
                    <DownloadSimple size={16} aria-hidden="true" /> {t.template}
                  </a>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv"
                  className="visually-hidden"
                  aria-label={t.priceFile}
                  tabIndex={-1}
                  onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)}
                />
                {fileInfo?.problem ? (
                  <span className="error-text" role="alert">
                    {localizeServerMessage(fileInfo.problem)}
                  </span>
                ) : fileInfo ? (
                  <span className="help">{t.fileInfo(num(fileInfo.size / 1024, 0), day(fileInfo.firstDay), day(fileInfo.lastDay))}</span>
                ) : (
                  <span className="help">{t.drop}</span>
                )}
              </div>
            </fieldset>
          </div>

          <aside className="aside">
            <div className="aside-panel">
              <div className="summary">
                <span>
                  <Rich text={t.summary(span ? num(span) : "?", span ? num(span * 24) : "?")} tags={numberTag} />
                </span>
                <span>{file ? t.pricesFrom(file.name) : t.bundled}</span>
              </div>
              {shownFailure ? (
                <div className="banner error" role="alert">
                  <WarningCircle size={18} aria-hidden="true" />
                  <span>
                    <span className="banner-title">{shownFailure.title}.</span> {shownFailure.detail}
                  </span>
                </div>
              ) : null}
              {touched && !valid ? <span className="error-text">{t.fixFields}</span> : null}
              {auth.account ? (
                <>
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    {t.phase[phase]}
                  </button>
                  <p className="quota">
                    {quota ? (
                      <Rich text={t.quota(quota.quota.remaining, quota.quota.limit)} tags={{ b: (text) => <strong>{text}</strong> }} />
                    ) : (
                      t.checkingQuota
                    )}
                  </p>
                </>
              ) : (
                <>
                  <button type="submit" className="btn btn-primary">
                    <SignIn size={16} weight="bold" aria-hidden="true" /> {t.signInToRun}
                  </button>
                  <p className="quota">{t.signInNote}</p>
                </>
              )}
            </div>
          </aside>
        </form>
      </div>
    </div>
  );
}
