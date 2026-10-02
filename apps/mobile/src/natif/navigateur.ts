import { APP_REDIRECT_URI } from "@gamedashboard/contracts";
import * as WebBrowser from "expo-web-browser";

/**
 * Ouvre la page de liaison dans le navigateur système
 * (ASWebAuthenticationSession sur iOS, Custom Tabs sur Android) et attend le
 * retour vers `gamedashboard://liaison`.
 *
 * Pas de session éphémère : le navigateur garde la connexion au panel que la
 * personne a peut-être déjà, et ses clés d'accès. L'application, elle, ne lit
 * jamais ce qui s'y tape.
 */
export async function ouvrirLiaison(url: string): Promise<string | null> {
  const resultat = await WebBrowser.openAuthSessionAsync(url, APP_REDIRECT_URI, {
    preferEphemeralSession: false,
  });
  return resultat.type === "success" ? resultat.url : null;
}

/** Ouvre une page du panel dans le navigateur (ce qui reste sur le web). */
export function ouvrirPanel(adresse: string, chemin = "/"): Promise<unknown> {
  return WebBrowser.openBrowserAsync(`${adresse}${chemin}`);
}
