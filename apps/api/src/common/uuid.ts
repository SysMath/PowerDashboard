/**
 * Un identifiant que PostgreSQL saura comparer à une colonne UUID.
 *
 * Une valeur illisible arrivait jusqu'à la base, qui refusait la conversion :
 * une erreur 500 rendue à l'appelant pour ce qui n'est qu'un compte ou un
 * serveur introuvable. Les routes la testent avant toute requête et disent
 * « introuvable », comme pour un identifiant bien formé qui ne désigne rien.
 */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
