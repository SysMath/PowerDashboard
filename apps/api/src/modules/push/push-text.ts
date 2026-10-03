import type { PushMessage } from "@gamedashboard/contracts";
import { messagesFor } from "@gamedashboard/i18n";

/**
 * Le texte affiché par le téléphone, composé à partir du seul contenu fermé
 * (type, nom du serveur, langue) : « Survie » et « Serveur injoignable ».
 * Ni le panel ni un relais ne choisissent leurs mots : ils viennent du
 * catalogue de traductions, et un type inconnu n'a pas de texte.
 */
export function pushText(message: Pick<PushMessage, "type" | "serveur" | "langue">): {
  title: string;
  body: string;
} {
  const messages = messagesFor(message.langue);
  const [groupe = "", cle = ""] = message.type.split(".", 2);
  const evenements = messages.notificationPrefs.event as Record<string, Record<string, string>>;
  const libelle = evenements[groupe]?.[cle] ?? messages.mobile.pousse.nouvelle;
  return message.serveur
    ? { title: message.serveur, body: libelle }
    : { title: libelle, body: messages.mobile.pousse.lire };
}
