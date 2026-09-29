import type { Logger } from "@nestjs/common";
import type { WingsClientService } from "./wings-client.service";

/**
 * Coupe chez Wings les sessions SFTP et les consoles de ces comptes sur un
 * serveur, et rend ceux pour qui le node n'a pas répondu.
 *
 * Un appel à `deauthorizeUser` par compte : la route de Wings n'en prend
 * qu'un. Les appels partent ensemble, pas l'un après l'autre : un node
 * injoignable fait attendre chacun jusqu'à son délai, et une suspension
 * ne doit pas durer le délai multiplié par le nombre d'invités.
 *
 * Aucun échec ne remonte : le geste qui l'appelle (retrait d'un accès,
 * suspension, changement de titulaire) est déjà fait en base, et la base
 * refuse déjà toute nouvelle connexion. Ce qui reste à dire, c'est quelle
 * session a pu rester ouverte : l'appelant le rend à qui a agi.
 */
export async function closeSessions(
  wings: Pick<WingsClientService, "deauthorizeUser">,
  serverId: string,
  userIds: readonly string[],
  logger: Pick<Logger, "warn">,
  geste: string,
): Promise<string[]> {
  const comptes = [...new Set(userIds)];
  const issues = await Promise.allSettled(
    comptes.map((userId) => wings.deauthorizeUser(serverId, userId)),
  );

  const restes: string[] = [];
  issues.forEach((issue, index) => {
    if (issue.status === "fulfilled") return;
    const userId = comptes[index] as string;
    restes.push(userId);
    const raison = issue.reason instanceof Error ? issue.reason.message : String(issue.reason);
    logger.warn(
      `${geste} de ${serverId} : les sessions de ${userId} n'ont pas pu être fermées (${raison}).`,
    );
  });
  return restes;
}
