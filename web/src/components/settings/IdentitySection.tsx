import { useI18n } from "../../i18n";
import { Section, TextField, type TabProps } from "./fields";

/**
 * Who counts as "me" (to skip translating or hide your own lines). A name from Steam is only a suggestion; only names the
 * user confirmed or that the game's own log confirmed count (see src/cs2/identity.ts for why a name alone proves nothing).
 */
export function IdentitySection({ app, commit, errors }: TabProps) {
  const { t } = useI18n();
  const id = app.identity;
  const save = (names: string[]) => commit({ cs2: { selfNames: names } }, "cs2.selfNames");

  return (
    <Section title={t("cs2.name.title")}>
      {id.logConfirmed && <p className="ok">✓ {t("cs2.name.logConfirmed", { name: id.logConfirmed })}</p>}
      {id.suggestSteam && id.steam && (
        <div className="notice-box">
          <p>{t("cs2.name.steam", { name: id.steam })}</p>
          <button type="button" className="btn" onClick={() => void save([...id.manual, id.steam!])}>
            {t("cs2.name.useSteam")}
          </button>
        </div>
      )}
      {id.authorized.length === 0 && !id.suggestSteam && <p className="warn">{t("cs2.name.none")}</p>}

      <TextField
        label={t("cs2.name.manual")}
        value={id.manual.join(", ")}
        error={errors["cs2.selfNames"]}
        help={t("cs2.name.manualHelp")}
        placeholder={id.steam ?? ""}
        onCommit={(v) =>
          void save(
            v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
      <details className="advanced">
        <summary>{t("cs2.name.securityTitle")}</summary>
        <p className="help">{t("cs2.name.security")}</p>
        <p className="muted help">{t("cs2.name.logNote")}</p>
      </details>
    </Section>
  );
}
