import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { SettingsPatch } from "../../../src/config/schema";
import { RIGHT_PCT_DEFAULT, RIGHT_PCT_MAX, RIGHT_PCT_MIN } from "@shared/layout";
import { useI18n } from "../i18n";

const KEY_STEP = 2;
const KEY_STEP_BIG = 5;
const SAVE_DELAY_MS = 400;

const clampPct = (n: number) => Math.min(RIGHT_PCT_MAX, Math.max(RIGHT_PCT_MIN, n));

interface Props {
  /** Saved share of the right column in percent; null = never set, use the default (70 / 30). */
  pct: number | null;
  collapsed: boolean;
  onSave: (patch: SettingsPatch) => Promise<unknown>;
  left: ReactNode;
  right: ReactNode;
}

/**
 * Two columns with a draggable divider and a collapsible right side.
 *
 * Width is a CSS variable (`--right-pct`) that the browser clamps with CSS (see `.workspace`), so dragging only
 * writes one style property: no React render per mouse move. The value is saved when the drag ends. Collapsing hides
 * the right column with CSS instead of unmounting it, so drafts, quick-talk state and the prepared message survive.
 */
export function Workspace({ pct: savedPct, collapsed, onSave, left, right }: Props) {
  const pct = savedPct ?? RIGHT_PCT_DEFAULT;
  const { t } = useI18n();
  const rootRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const sepRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  /** The last width asked for; used when the browser cannot measure the layout (it is the value being saved). */
  const wanted = useRef(pct);
  useEffect(() => {
    wanted.current = pct;
  }, [pct]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const px = (v: string) => parseFloat(v) || 0;

  /** The share the right column actually has right now (after CSS clamping), in percent of the content width. */
  const actualPct = (): number => {
    const root = rootRef.current;
    const side = sideRef.current;
    if (!root || !side) return wanted.current;
    const cs = getComputedStyle(root);
    const content = root.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
    return content > 0 ? (side.getBoundingClientRect().width / content) * 100 : wanted.current;
  };

  const apply = (value: number) => {
    wanted.current = clampPct(value);
    rootRef.current?.style.setProperty("--right-pct", `${wanted.current.toFixed(2)}%`);
    const sep = sepRef.current;
    if (sep) sep.setAttribute("aria-valuenow", String(Math.round(actualPct())));
  };

  const commit = () => {
    window.clearTimeout(timer.current);
    const value = Math.round(clampPct(actualPct()) * 10) / 10;
    void onSave({ appearance: { rightPct: value } });
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    root.classList.add("workspace--dragging");
    const move = (ev: globalThis.PointerEvent) => {
      const rect = root.getBoundingClientRect();
      const cs = getComputedStyle(root);
      const right = rect.right - px(cs.paddingRight);
      const content = rect.width - px(cs.paddingLeft) - px(cs.paddingRight);
      apply(((right - ev.clientX) / content) * 100);
    };
    const target = e.currentTarget;
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      root.classList.remove("workspace--dragging");
      commit();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    let next: number | null = null;
    // The divider sits left of the right column: moving it left makes the right column wider.
    if (e.key === "ArrowLeft") next = actualPct() + step;
    else if (e.key === "ArrowRight") next = actualPct() - step;
    else if (e.key === "Home") next = RIGHT_PCT_MAX;
    else if (e.key === "End") next = RIGHT_PCT_MIN;
    else if (e.key === "Enter" || e.key === "Escape") next = RIGHT_PCT_DEFAULT;
    if (next === null) return;
    e.preventDefault();
    apply(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(commit, SAVE_DELAY_MS);
  };

  const reset = () => {
    apply(RIGHT_PCT_DEFAULT);
    window.clearTimeout(timer.current);
    void onSave({ appearance: { rightPct: null } }); // "never set": the default applies from now on
  };

  const style = { "--right-pct": `${pct}%` } as CSSProperties;
  return (
    <main ref={rootRef} className={collapsed ? "workspace workspace--collapsed" : "workspace"} style={style}>
      {left}
      <div
        ref={sepRef}
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("layout.resize")}
        aria-valuemin={RIGHT_PCT_MIN}
        aria-valuemax={RIGHT_PCT_MAX}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={t("layout.rightWidth", { n: Math.round(pct) })}
        title={t("layout.resizeHint")}
        tabIndex={collapsed ? -1 : 0}
        aria-hidden={collapsed || undefined}
        onPointerDown={onPointerDown}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
      >
        <span className="splitter-grip" aria-hidden="true" />
      </div>
      <div ref={sideRef} className="panel side" inert={collapsed} aria-hidden={collapsed || undefined}>
        <button type="button" className="collapse-btn btn btn--ghost btn--small" onClick={() => void onSave({ appearance: { rightCollapsed: true } })} title={t("layout.collapse")} aria-label={t("layout.collapse")}>
          <span aria-hidden="true">⟩</span>
        </button>
        {right}
      </div>
    </main>
  );
}
