import { useEffect, useId, useState, type ReactNode } from "react";
import type { SettingsPatch } from "../../../../src/config/schema";
import type { AppState } from "@shared/protocol";
import { LanguageOptions } from "../LanguageOptions";

/** Saves a settings patch; resolves true when the server accepted it. `key` is the path the server reports errors under. */
export type Commit = (patch: SettingsPatch, key: string) => Promise<boolean>;

export interface TabProps {
  app: AppState;
  commit: Commit;
  errors: Record<string, string>;
  onRefresh: () => Promise<void>;
}

export function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="section">
      <h3 className="section-title">{title}</h3>
      {hint && <p className="muted help">{hint}</p>}
      {children}
    </section>
  );
}

export function Row({
  label,
  help,
  error,
  children,
  htmlFor,
}: {
  label: string;
  help?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="setting">
      <label className="setting-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {help && <p className="muted help">{help}</p>}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Check({
  label,
  checked,
  onChange,
  help,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  help?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="setting setting--check">
      <label htmlFor={id} className="check">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {help && <p className="muted help help--indent">{help}</p>}
    </div>
  );
}

/** Text input that keeps a local draft and saves on blur / Enter, so typing is never interrupted by validation. */
export function TextField({
  label,
  value,
  onCommit,
  help,
  error,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  help?: ReactNode;
  error?: string | undefined;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const done = () => draft !== value && onCommit(draft);
  return (
    <Row label={label} help={help} error={error} htmlFor={id}>
      <input
        id={id}
        type="text"
        className={mono ? "mono" : undefined}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => e.key === "Enter" && done()}
      />
    </Row>
  );
}

export function LanguageSelect({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <Row label={label} htmlFor={id}>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <LanguageOptions />
      </select>
    </Row>
  );
}

/** A small badge for a yes / no state, so status is not conveyed by colour alone. */
export function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={ok ? "status status--ok" : "status status--bad"}>
      <span aria-hidden="true">{ok ? "✓" : "✕"}</span> {children}
    </span>
  );
}

/** Runs `fn` after `ms` of the component being mounted with the same deps; used for short-lived confirmations. */
export function useTimedFlag(ms: number): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(() => setOn(false), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return [on, () => setOn(true)];
}
