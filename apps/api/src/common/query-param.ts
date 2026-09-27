import { BadRequestException } from "@nestjs/common";

/**
 * Un paramètre d'adresse qui ne doit porter qu'une valeur.
 *
 * Fastify rend en tableau un paramètre répété (`?q=a&q=b`), alors que le type
 * déclaré sur `@Query` dit `string` sans rien vérifier. Le tableau filait
 * jusqu'à un `.trim()` ou une requête SQL, et la réponse était une erreur 500
 * au lieu d'un refus.
 */
export function singleQuery(value: unknown, name: string): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  throw new BadRequestException(`Paramètre « ${name} » : une seule valeur est attendue.`);
}
