/**
 * Où mène une notification : l'écran du serveur dans l'application quand elle
 * en vise un, la page du panel sinon.
 */
export function cibleNotification(
  href: string | null,
): { serveur: string } | { chemin: string } | null {
  if (!href) return null;
  const serveur = /^\/server\/([0-9a-f-]{36})(?:\/|$)/.exec(href);
  if (serveur?.[1]) return { serveur: serveur[1] };
  return href.startsWith("/") && !href.startsWith("//") ? { chemin: href } : null;
}
