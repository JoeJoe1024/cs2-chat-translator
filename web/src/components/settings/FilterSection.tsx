import { useI18n } from "../../i18n";
import { Check, Row, Section, type TabProps } from "./fields";
import { useId, useState } from "react";

/** Smart filter, cache and (advanced) the freshness window plus the live counters of the translation service. */
export function FilterSection({ app, commit, errors }: TabProps) {
  const { t, locale } = useI18n();
  const g = app.settings.general;
  const tr = app.settings.translation;
  const s = app.runtime.stats;
  const id = useId();
  const [draft, setDraft] = useState(String(tr.staleAfterMs / 1000));
  const [seen, setSeen] = useState(tr.staleAfterMs);
  if (seen !== tr.staleAfterMs) {
    setSeen(tr.staleAfterMs);
    setDraft(String(tr.staleAfterMs / 1000));
  }
  const busy = s.waiting + s.running > 0;
  const n = (v: number) => v.toLocaleString(locale);

  const commitStale = () => {
    const seconds = Number(draft.replace(",", "."));
    if (!Number.isFinite(seconds)) return;
    void commit({ translation: { staleAfterMs: Math.round(seconds * 1000) } }, "translation.staleAfterMs");
  };

  return (
    <Section title={t("tr.perf.title")}>
      <Check label={t("tr.perf.smartFilter")} checked={g.smartFilter} onChange={(v) => void commit({ general: { smartFilter: v } }, "general.smartFilter")} help={t("tr.perf.smartFilterHelp")} />
      <Check label={t("tr.perf.cache")} checked={g.translationCache} onChange={(v) => void commit({ general: { translationCache: v } }, "general.translationCache")} />
      <p className={busy ? "warn" : "muted"} role="status">
        <strong>{t("tr.perf.status")}:</strong> {busy ? t("tr.perf.busy", { w: s.waiting, r: s.running }) : t("tr.perf.idle")}
      </p>

      <details className="advanced">
        <summary>{t("tr.perf.advanced")}</summary>
        <Row label={t("tr.perf.stale")} htmlFor={id} help={t("tr.perf.staleHelp")} error={errors["translation.staleAfterMs"]}>
          <input
            id={id}
            type="text"
            inputMode="decimal"
            className="narrow"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitStale}
            onKeyDown={(e) => e.key === "Enter" && commitStale()}
            aria-invalid={errors["translation.staleAfterMs"] ? true : undefined}
          />
        </Row>
        <dl className="stats">
          <dt>{t("tr.perf.waiting")}</dt>
          <dd>{n(s.waiting)}</dd>
          <dt>{t("tr.perf.latency")}</dt>
          <dd>{s.avgLatencyMs === null ? t("tr.perf.latencyNone") : `${n(s.avgLatencyMs)} ms`}</dd>
          <dt>{t("tr.perf.local")}</dt>
          <dd>{n(s.local)}</dd>
          <dt>{t("tr.perf.completed")}</dt>
          <dd>{n(s.completed)}</dd>
          <dt>{t("tr.perf.cacheHits")}</dt>
          <dd>
            {n(s.cacheHits)} / {n(s.cacheLookups)}
          </dd>
          <dt>{t("tr.perf.filtered")}</dt>
          <dd>{n(s.filtered)}</dd>
          <dt>{t("tr.perf.staleCount")}</dt>
          <dd>{n(s.stale)}</dd>
          <dt>{t("tr.perf.failed")}</dt>
          <dd>{n(s.failed)}</dd>
        </dl>
        <p className="muted help">{t("tr.perf.since")}</p>
      </details>
    </Section>
  );
}
