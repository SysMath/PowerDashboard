import { formatRelative } from "@gamedashboard/sdk/format";

export interface RelativeTimeProps {
  /**
   * Date ISO, ou son absence.
   *
   * **Nullable à dessein.** Le composant traite déjà le cas — il rend
   * `fallback` — mais le type l'interdisait, si bien qu'un appelant dont la
   * date est facultative devait écrire `value={date ?? ""}` : un contournement
   * qui ressemble à une erreur et qu'on finit par recopier sans le comprendre.
   * Les dates de ce panel sont facultatives presque partout — dernière
   * connexion, date d'installation, dernière exécution d'une tâche.
   */
  value: string | null | undefined;
  className?: string;
  /** Texte affiché si `value` est absente. */
  fallback?: string;
}

/**
 * Affiche une date en relatif (« il y a 51 minutes »).
 *
 * Le rendu serveur et le rendu client ont lieu à des instants différents, donc
 * le texte diffère forcément d'une seconde à l'autre. `suppressHydrationWarning`
 * dit à React d'accepter cet écart et de garder la valeur client, au lieu de
 * signaler une erreur d'hydratation et de re-rendre l'arbre.
 */
export function RelativeTime({ value, className, fallback = "—" }: RelativeTimeProps) {
  if (!value) return <span className={className}>{fallback}</span>;
  return (
    <time dateTime={value} className={className} suppressHydrationWarning>
      {formatRelative(value)}
    </time>
  );
}
