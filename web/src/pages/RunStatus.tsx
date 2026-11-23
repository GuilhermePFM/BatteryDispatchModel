import { ArrowCounterClockwise, Check, DownloadSimple, LinkSimple, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { isCurrentRecord, type Progress, type RunRecord } from "../contracts/types";
import { Dashboard } from "../dashboard/Dashboard";
import { messages, useI18n } from "../i18n";
import { localizeServerMessage } from "../i18n/server";
import { api, ApiError, describeError } from "../lib/api";
import { day, duration, num, pct } from "../lib/format";
import { valuesFromRequest } from "../lib/validation";
import { DRAFT_KEY } from "./Run";

const POLL_MS = 3000;

function phaseLabel(progress: Progress | undefined, status: RunRecord["status"]): string {
  const { status: t, common } = messages();
  if (status === "queued") return t.waiting;
  if (!progress) return t.starting;
  if (progress.phase === "done") return t.writing;
  return progress.submarket && progress.case ? t.solvingCase(progress.submarket, common.cases[progress.case]) : t.solving;
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v" style={{ fontSize: "1.1rem" }}>
        {v}
      </div>
    </div>
  );
}

function ProgressPanel({ record }: { record: RunRecord }) {
  const { t: all } = useI18n();
  const t = all.status;
  const na = all.common.na;
  const p = record.progress;
  const queued = record.status === "queued";
  const fraction = p ? Math.max(0, Math.min(1, p.fraction)) : 0;
  return (
    <>
      <div
        className={`progress${queued || !p ? " indeterminate" : ""}`}
        role="progressbar"
        aria-label={t.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={queued || !p ? undefined : Math.round(fraction * 100)}
      >
        <span style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="progress-facts">
        <Fact k={t.done} v={queued || !p ? na : pct(fraction, 0)} />
        <Fact k={t.programs} v={p ? t.programsValue(p.cases_done, p.cases_total) : na} />
        <Fact k={t.inFlight} v={p?.submarket && p.case ? `${p.submarket}, ${all.common.cases[p.case]}` : na} />
        <Fact k={t.elapsed} v={p ? duration(p.elapsed) : na} />
      </div>
      <p className="help">{t.progressNote}</p>
    </>
  );
}

function RequestSummary({ record }: { record: RunRecord }) {
  const { t: all } = useI18n();
  const t = all.status;
  const r = record.request;
  const b = r.battery;
  return (
    <p className="dash-meta">
      {t.summary(day(r.start), day(r.end), num(b.power_mw, 1), num(b.volume_mwh, 1))}
      {r.cycle_budget !== undefined ? t.cycleBudget(num(r.cycle_budget)) : ""}
      {r.prices_key ? t.uploadedPrices : t.bundledPrices}.
    </p>
  );
}

/** Keyed by id, so moving to another run starts from a clean state. */
export function RunStatus() {
  const { id = "" } = useParams();
  return <RunStatusView key={id} id={id} />;
}

function RunStatusView({ id }: { id: string }) {
  const { t: all } = useI18n();
  const t = all.status;
  const location = useLocation();
  const navigate = useNavigate();
  const cached = (location.state as { cached?: boolean } | null)?.cached ?? false;
  const [record, setRecord] = useState<RunRecord | null>(null);
  // The error itself, so its text follows a change of language.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    let misses = 0;
    async function poll() {
      try {
        const next = await api.getRun(id);
        if (!live) return;
        misses = 0;
        setRecord(next);
        setFailure(null);
        if (next.status === "queued" || next.status === "running") timer = window.setTimeout(poll, POLL_MS);
      } catch (error) {
        if (!live) return;
        const notFound = error instanceof ApiError && error.status === 404;
        // A dropped poll is retried quietly a few times before it is shown.
        misses += 1;
        if (notFound || misses >= 3) setFailure({ error });
        if (!notFound) timer = window.setTimeout(poll, POLL_MS * Math.min(4, misses));
      }
    }
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [id]);

  function editAndRetry() {
    if (!record) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(valuesFromRequest(record.request)));
    } catch {
      // ignore
    }
    navigate("/run");
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const stale = record !== null && !isCurrentRecord(record);
  const status = stale ? undefined : record?.status;
  const result = stale ? undefined : record?.result;
  const shownFailure = failure ? describeError(failure.error) : null;

  return (
    <div className="page">
      <div className="wrap">
        <div className="page-head">
          <h1>{stale ? t.older : status === "succeeded" ? t.yourPlan : status === "failed" ? t.failedTitle : t.planning}</h1>
          {record && !stale ? <RequestSummary record={record} /> : null}
        </div>

        {stale ? (
          <div className="status-panel">
            <div className="banner" role="status">
              <WarningCircle size={18} aria-hidden="true" />
              <span>
                <span className="banner-title">{t.staleTitle}</span> {t.staleText}
              </span>
            </div>
            <div className="actions">
              <Link className="btn btn-primary" to="/run">
                {t.startRun}
              </Link>
            </div>
          </div>
        ) : shownFailure && !record ? (
          <div className="status-panel">
            <div className="banner error" role="alert">
              <WarningCircle size={18} aria-hidden="true" />
              <span>
                <span className="banner-title">{shownFailure.title}.</span> {shownFailure.detail}
              </span>
            </div>
            <div className="actions">
              <Link className="btn btn-primary" to="/run">
                {t.startRun}
              </Link>
            </div>
          </div>
        ) : !record ? (
          <div className="status-panel">
            {/* Nothing to show until the first poll answers. */}
            <div className="progress indeterminate">
              <span />
            </div>
          </div>
        ) : status === "queued" || status === "running" ? (
          <div className="status-panel" aria-live="polite">
            <div className="status-line">
              <span className="status-badge" data-status={status}>
                {t.badge[status]}
              </span>
              {phaseLabel(record.progress, record.status)}
            </div>
            <ProgressPanel record={record} />
            {failure ? <p className="help">{t.lostTouch}</p> : null}
            <p className="help">{t.canLeave}</p>
          </div>
        ) : status === "failed" ? (
          <div className="status-panel">
            <div className="status-line">
              <span className="status-badge" data-status="failed">
                {t.badge.failed}
              </span>
              {record.error?.code === "prices_invalid" ? t.priceRejected : record.error?.code === "request_invalid" ? t.requestRejected : t.solverFailed}
            </div>
            <div className="error-message">{record.error?.message ? localizeServerMessage(record.error.message) : t.noReason}</div>
            <p className="help">{t.notCounted}</p>
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={editAndRetry}>
                <ArrowCounterClockwise size={16} aria-hidden="true" /> {t.editRetry}
              </button>
            </div>
          </div>
        ) : null}

        {status === "succeeded" ? (
          <>
            <div className="actions" style={{ marginTop: 24 }}>
              {record?.plan_csv_url ? (
                <a className="btn btn-primary" href={record.plan_csv_url} download="dispatch_plan.csv">
                  <DownloadSimple size={16} weight="bold" aria-hidden="true" /> {t.download}
                </a>
              ) : null}
              <button type="button" className="btn btn-secondary" onClick={copyLink}>
                {copied ? <Check size={16} aria-hidden="true" /> : <LinkSimple size={16} aria-hidden="true" />} {copied ? t.copied : t.copyLink}
              </button>
              <button type="button" className="btn btn-quiet" onClick={editAndRetry}>
                {t.changeRun}
              </button>
              {cached ? <span className="help">{t.cached}</span> : null}
            </div>
            <div className="dashboard" style={{ paddingTop: 0 }}>
              {result ? (
                <div style={{ marginTop: 28 }}>
                  <Dashboard result={result} runMonth={record?.created_at.slice(0, 7)} />
                </div>
              ) : (
                <div className="banner error" style={{ marginTop: 24 }}>
                  <WarningCircle size={18} aria-hidden="true" />
                  <span>{t.missingResult}</span>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
