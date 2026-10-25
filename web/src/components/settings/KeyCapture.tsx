import { useEffect, useId, useState } from "react";
import {
  allBindableKeys,
  captureKeyboard,
  captureMouseButton,
  captureWheel,
  defaultUseOf,
  describeBind,
  type CaptureResult,
  type Cs2Key,
  type KeyGroup,
} from "@shared/cs2keys";
import { useI18n, type MessageKey } from "../../i18n";
import { unbindCommand } from "@shared/cfgEncode";
import { CopyLine } from "./CopyLine";
import { Row } from "./fields";

type Props = {
  current: string;
  onApply: (bind: string) => Promise<boolean>;
  error?: string | undefined;
};

const GROUPS: KeyGroup[] = ["letter", "digit", "function", "numpad", "navigation", "mouse"];

type Pending = { key: Cs2Key; layoutNote?: boolean };

/**
 * "Press the key you want": listens for a key / mouse button / wheel notch and converts it to the name CS2's `bind`
 * understands (see shared/cs2keys). Nothing is saved until the user confirms, so conflicts can be reviewed first.
 */
export function KeyCapture({ current, onApply, error }: Props) {
  const { t } = useI18n();
  const listId = useId();
  const [listening, setListening] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const handle = (r: CaptureResult) => {
    if (r.status === "cancel") {
      setListening(false);
      return;
    }
    if (r.status === "unsupported") {
      setProblem(t(`cs2.key.unsupported.${r.reason}` as MessageKey));
      return;
    }
    setProblem(null);
    setPending({ key: r.key, ...(r.layoutNote ? { layoutNote: true } : {}) });
    setListening(false);
  };

  useEffect(() => {
    if (!listening) return;
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onKey = (e: KeyboardEvent) => {
      swallow(e);
      if (!e.repeat) handle(captureKeyboard({ code: e.code, key: e.key }));
    };
    // Side buttons would otherwise navigate the browser back / forward; the middle button would start auto-scroll.
    const onMouse = (e: MouseEvent) => {
      if (e.button === 0 || e.button === 2) return;
      swallow(e);
      if (e.type === "mousedown") handle(captureMouseButton(e.button));
    };
    const onWheel = (e: WheelEvent) => {
      swallow(e);
      handle(captureWheel(e.deltaY));
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    window.addEventListener("mouseup", onMouse, true);
    window.addEventListener("auxclick", onMouse, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
      window.removeEventListener("mouseup", onMouse, true);
      window.removeEventListener("auxclick", onMouse, true);
      window.removeEventListener("wheel", onWheel, true);
    };
    // `handle` only uses setters and `t`; re-subscribing on every render would drop events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  const known = describeBind(current);
  const label = (k: Cs2Key) => t("cs2.key.friendly", { label: k.label, bind: k.bind });
  const use = pending ? defaultUseOf(pending.key.bind) : null;

  const apply = async () => {
    if (!pending) return;
    const old = current;
    if (await onApply(pending.key.bind)) {
      setPrevious(old !== pending.key.bind ? old : null);
      setApplied(true);
      setPending(null);
    }
  };

  return (
    <div className="setting">
      <span className="setting-label">{t("cs2.key.title")}</span>
      <p className="muted help">{t("cs2.key.help")}</p>

      <div className="keyline">
        <kbd className="keycap">{known ? known.label : current.toUpperCase()}</kbd>
        <span className="muted">{known ? t("cs2.key.friendly", { label: known.label, bind: known.bind }) : ""}</span>
        <span className="spacer" />
        {!listening ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setProblem(null);
              setPending(null);
              setApplied(false);
              setListening(true);
            }}
          >
            {t("cs2.key.change")}
          </button>
        ) : (
          <button type="button" className="btn btn--ghost" onClick={() => setListening(false)}>
            {t("cs2.key.cancel")}
          </button>
        )}
      </div>
      {!known && <p className="warn help">{t("cs2.key.customName", { bind: current })}</p>}

      {listening && (
        <p className="capture" role="status" aria-live="assertive">
          {t("cs2.key.press")}
        </p>
      )}
      {problem && (
        <p className="alert" role="alert">
          {problem}
        </p>
      )}

      {pending && (
        <div className="capture-result">
          <p>
            <kbd className="keycap">{pending.key.label}</kbd> <span className="muted">{label(pending.key)}</span>
          </p>
          {pending.layoutNote && <p className="muted help">{t("cs2.key.layoutNote", { bind: pending.key.bind })}</p>}
          {pending.key.group === "numpad" && <p className="muted help">{t("cs2.key.numpadNote")}</p>}
          {use && (
            <p className="warn help">{t("cs2.key.conflict", { key: pending.key.label, use: t(`keyuse.${use}` as MessageKey) })}</p>
          )}
          <div className="row">
            <button type="button" className="btn btn--primary" onClick={() => void apply()}>
              {t("cs2.key.apply")}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setPending(null)}>
              {t("cs2.key.cancel")}
            </button>
          </div>
        </div>
      )}

      <Row label={t("cs2.key.pickList")} htmlFor={listId}>
        <select
          id={listId}
          value=""
          onChange={(e) => {
            const picked = allBindableKeys().find((k) => k.bind === e.target.value);
            if (picked) {
              setProblem(null);
              setApplied(false);
              setPending({ key: picked });
            }
          }}
        >
          <option value="">{t("cs2.key.listPlaceholder")}</option>
          {GROUPS.map((g) => (
            <optgroup key={g} label={t(`cs2.key.group.${g}` as MessageKey)}>
              {allBindableKeys()
                .filter((k) => k.group === g)
                .map((k) => (
                  <option key={k.bind} value={k.bind}>
                    {k.label} ({k.bind})
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </Row>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {applied && previous && (
        <div className="commands">
          <p className="muted help">{t("cs2.key.oldBinding", { old: previous })}</p>
          <CopyLine text={unbindCommand(previous)} />
        </div>
      )}
    </div>
  );
}
