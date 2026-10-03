import { LOCALE_COOKIE, messagesFor, resolveLocale } from "@gamedashboard/i18n";
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

/**
 * Langue de la requête.
 *
 * Pas de segment `[locale]` dans les URL : un panel est entièrement
 * authentifié, la langue appartient au compte et non à l'adresse. Un lien vers
 * un serveur partagé entre collègues s'ouvre ainsi dans la langue de celui qui
 * clique, et non dans celle de qui a copié l'URL.
 *
 * L'ordre est celui de `resolveLocale` : compte, puis cookie, puis navigateur.
 * La lecture du compte arrivera avec la session ; d'ici là, le cookie et
 * l'en-tête suffisent.
 */
export default getRequestConfig(async () => {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);

  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerList.get("accept-language"),
  });

  // Les textes de l'application mobile (ADR 0010) vivent dans le même
  // catalogue, mais n'ont rien à faire dans chaque page du panel.
  const { mobile: _mobile, ...messages } = messagesFor(locale);

  return {
    locale,
    messages,
    // Le fuseau vient du profil (§6.1). Tant que la session n'existe pas, une
    // valeur fixe vaut mieux que celle du serveur : une date rendue côté
    // serveur et côté client doit tomber sur le même texte.
    timeZone: "Europe/Paris",
    now: new Date(),
    onError(error) {
      // Une clé manquante ne doit pas faire tomber la page, mais elle ne doit
      // pas non plus passer inaperçue. Les tests de `@gamedashboard/i18n` la
      // rattrapent avant la production ; ici on se contente de la journaliser.
      if (process.env.NODE_ENV !== "production") console.warn(error.message);
    },
    getMessageFallback({ namespace, key }) {
      // Afficher le chemin de la clé plutôt qu'une chaîne vide : un libellé
      // absent doit se voir, pas produire un bouton sans texte.
      return [namespace, key].filter(Boolean).join(".");
    },
  };
});
