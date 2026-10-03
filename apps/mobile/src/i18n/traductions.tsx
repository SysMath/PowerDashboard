import { messagesFor, resolveLocale } from "@gamedashboard/i18n";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";

/**
 * Les traductions du panel (`@gamedashboard/i18n`), mêmes clés que le web.
 *
 * La langue est celle du téléphone, ramenée à celles du panel (le français à
 * défaut) ; le fuseau aussi.
 */
const reglages = Intl.DateTimeFormat().resolvedOptions();
const langue = resolveLocale({ acceptLanguage: reglages.locale });

export function Traductions({ children }: { children: ReactNode }) {
  return (
    <IntlProvider locale={langue} messages={messagesFor(langue)} timeZone={reglages.timeZone}>
      {children}
    </IntlProvider>
  );
}
