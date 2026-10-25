import type { AppState } from "@shared/protocol";
import { bindCommand, execCommand } from "@shared/cfgEncode";
import { useI18n } from "../../i18n";
import { CopyLine } from "./CopyLine";
import { Section } from "./fields";

/** The three things to paste once. Everything is derived from the current settings, so it updates the moment the key or file name changes. */
export function FirstUseSection({ app }: { app: AppState }) {
  const { t } = useI18n();
  const { bindKey, cfgFileName } = app.settings.cs2;
  return (
    <Section title={t("cs2.setup.title")} hint={t("cs2.setup.intro")}>
      <div className="step">
        <h4>{t("cs2.setup.steam")}</h4>
        <CopyLine text="-condebug" />
        <p className="muted help">{t("cs2.setup.steamHelp")}</p>
      </div>
      <div className="step">
        <h4>{t("cs2.setup.console")}</h4>
        <CopyLine text={bindCommand(bindKey, cfgFileName)} />
        <p className="muted help">{t("cs2.setup.consoleHelp")}</p>
      </div>
      <div className="step">
        <h4>{t("cs2.setup.test")}</h4>
        <CopyLine text={execCommand(cfgFileName)} />
        <p className="muted help">{t("cs2.setup.testHelp")}</p>
      </div>
      <details className="advanced">
        <summary>{t("cs2.setup.more")}</summary>
        <p className="help">{t("cs2.setup.consoleOpen")}</p>
        <p className="help">{t("cs2.setup.changeKey")}</p>
        <p className="help">{t("cs2.setup.same")}</p>
      </details>
    </Section>
  );
}
