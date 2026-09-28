"use server";

import type { EggDraft, RolePresets } from "@gamedashboard/contracts";
import { revalidatePath } from "next/cache";
import type { AdminNodeShare } from "./admin";
import { apiFetch, apiSend, apiSendFor } from "./client";
import type { ResellerQuotaReport } from "./reseller";

/**
 * Actions d'administration.
 *
 * Fichier distinct des lectures : `"use server"` impose que **tout** export
 * soit une fonction asynchrone, ce qui exclut les types et les lectures écrites
 * en flèche. Les mêler obligerait à tout tordre pour satisfaire la directive.
 */

/**
 * Enregistre des réglages.
 *
 * `bases` porte, pour le logo et le favicon, la valeur que le formulaire a vue
 * en dernier côté serveur : l'API garde une image envoyée depuis au lieu de
 * l'écraser, et le dit dans `kept`. `images` rend les deux réglages d'image
 * tels qu'ils sont en base après l'écriture, pour que le formulaire s'y recale.
 */
export async function savePlatformSettings(
  values: Record<string, string | number | boolean>,
  bases?: Record<string, string>,
): Promise<{ error: string | null; kept: string[]; images: Record<string, string> | null }> {
  try {
    const { data } = await apiSendFor<{
      data: { kept?: string[]; images?: Record<string, string> };
    }>("/api/v1/admin/settings", bases ? { values, bases } : { values });
    revalidatePath("/admin/settings");
    return { error: null, kept: data.kept ?? [], images: data.images ?? null };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Action refusée.",
      kept: [],
      images: null,
    };
  }
}

/**
 * Redéfinit les presets de sous-utilisateurs.
 *
 * Les sous-utilisateurs existants n'en sont pas touchés : leurs permissions
 * ont été recopiées à l'invitation. L'API valide chaque permission.
 */
export async function saveSubuserPresets(presets: RolePresets): Promise<{ error: string | null }> {
  return act("/admin/settings", () => apiSend("/api/v1/admin/subuser-presets", { presets }));
}

/** Rétablit les presets du code. */
export async function resetSubuserPresets(): Promise<{ error: string | null }> {
  return act("/admin/settings", () => apiSend("/api/v1/admin/subuser-presets/reset", {}));
}

/**
 * Éprouve le SMTP en s'envoyant un courrier.
 *
 * Ne rend **pas** `{ error }` comme les autres actions : un envoi refusé n'est
 * pas une action refusée. La requête a abouti, l'API a répondu, et la cause du
 * refus vient du serveur de courrier — la montrer dans le bandeau rouge
 * « enregistrement refusé » ferait croire que les réglages n'ont pas été pris.
 *
 * Le destinataire n'est pas un paramètre : l'API envoie à l'administrateur qui
 * demande, et le lui laisser choisir ferait du panel un relais ouvert.
 */
export async function testSmtp(): Promise<{
  ok: boolean;
  error: string | null;
  sentTo: string | null;
}> {
  try {
    const { data } = await apiSendFor<{
      data: { ok: boolean; error: string | null; sentTo: string | null };
    }>("/api/v1/admin/settings/smtp/test", {});
    return data;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Essai impossible.",
      sentTo: null,
    };
  }
}

/**
 * Essai de la liaison avec le facturier.
 *
 * Même forme que l'essai SMTP, et pour la même raison : un refus du facturier
 * n'est pas une action refusée, et sa phrase est ce que l'exploitant doit lire.
 */
export async function testBilling(): Promise<{
  ok: boolean;
  provider: string | null;
  knowsCaller: boolean;
  error: string | null;
}> {
  try {
    const { data } = await apiSendFor<{
      data: { ok: boolean; provider: string | null; knowsCaller: boolean; error: string | null };
    }>("/api/v1/admin/settings/billing/test", {});
    return data;
  } catch (error) {
    return {
      ok: false,
      provider: null,
      knowsCaller: false,
      error: error instanceof Error ? error.message : "Essai impossible.",
    };
  }
}

/**
 * Essai de la zone DNS des sous-domaines : même forme que l'essai du facturier,
 * la phrase du fournisseur est ce que l'exploitant doit lire.
 */
export async function testDns(): Promise<{
  ok: boolean;
  zone: string | null;
  error: string | null;
}> {
  try {
    const { data } = await apiSendFor<{
      data: { ok: boolean; zone: string | null; error: string | null };
    }>("/api/v1/admin/settings/dns/test", {});
    return data;
  } catch (error) {
    return {
      ok: false,
      zone: null,
      error: error instanceof Error ? error.message : "Essai impossible.",
    };
  }
}

export async function setFeatureFlag(
  key: string,
  enabled: boolean,
): Promise<{ error: string | null }> {
  return act("/admin/settings", () =>
    apiSend(`/api/v1/admin/settings/flags/${encodeURIComponent(key)}`, { enabled }),
  );
}

/**
 * Crée un compte depuis l'administration.
 *
 * Rend le mot de passe provisoire, qui ne repassera plus : l'écran doit
 * l'afficher tout de suite, et l'administrateur le transmettre. Le stocker
 * ailleurs pour « pouvoir le retrouver » reviendrait à garder un mot de passe
 * en clair — exactement ce que le tirage au sort évite.
 */
export async function createUser(input: {
  email: string;
  nameFirst: string;
  nameLast: string;
  role: string;
  withPassword: boolean;
}): Promise<{ error: string | null; temporaryPassword: string | null }> {
  try {
    const { data } = await apiSendFor<{ data: { id: string; temporaryPassword: string | null } }>(
      "/api/v1/admin/users",
      input,
    );
    revalidatePath("/admin/users");
    return { error: null, temporaryPassword: data.temporaryPassword };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Création refusée.",
      temporaryPassword: null,
    };
  }
}

export async function setUserRole(userId: string, role: string): Promise<{ error: string | null }> {
  return act("/admin/users", () => apiSend(`/api/v1/admin/users/${userId}/role`, { role }));
}

export async function revokeUserSessions(userId: string): Promise<{ error: string | null }> {
  return act("/admin/users", () => apiSend(`/api/v1/admin/users/${userId}/revoke-sessions`, {}));
}

export async function deleteUser(userId: string): Promise<{ error: string | null }> {
  return act("/admin/users", () => apiSend(`/api/v1/admin/users/${userId}`, undefined, "DELETE"));
}

/**
 * Suspend ou rétablit. `sessionsNotClosed` compte les comptes dont le node
 * n'a pas confirmé la fermeture des sessions : la suspension est faite quand
 * même, l'écran le signale.
 */
export async function setServerSuspended(
  serverId: string,
  suspended: boolean,
  reason = "",
): Promise<{ error: string | null; sessionsNotClosed: number }> {
  let sessionsNotClosed = 0;
  const result = await act("/admin/servers", async () => {
    const { data } = await apiSendFor<{ data: { sessionsNotClosed?: number } }>(
      `/api/v1/admin/servers/${serverId}/suspend`,
      { suspended, reason },
    );
    sessionsNotClosed = data.sessionsNotClosed ?? 0;
  });
  return { ...result, sessionsNotClosed };
}

export async function deleteServer(serverId: string): Promise<{ error: string | null }> {
  return act("/admin/servers", () =>
    apiSend(`/api/v1/admin/servers/${serverId}`, undefined, "DELETE"),
  );
}

/* --- Classement, localisations et création de nodes ----------------------- */

export async function createNodeCategory(
  name: string,
  description: string,
): Promise<{ error: string | null }> {
  return act("/admin/nodes", () => apiSend("/api/v1/admin/node-categories", { name, description }));
}

export async function removeNodeCategory(categoryId: string): Promise<{ error: string | null }> {
  return act("/admin/nodes", () =>
    apiSend(`/api/v1/admin/node-categories/${categoryId}`, undefined, "DELETE"),
  );
}

export async function createNodeSubcategory(
  categoryId: string,
  name: string,
): Promise<{ error: string | null }> {
  return act("/admin/nodes", () =>
    apiSend("/api/v1/admin/node-subcategories", { categoryId, name }),
  );
}

export async function removeNodeSubcategory(id: string): Promise<{ error: string | null }> {
  return act("/admin/nodes", () =>
    apiSend(`/api/v1/admin/node-subcategories/${id}`, undefined, "DELETE"),
  );
}

export async function createLocation(input: {
  short: string;
  long: string;
  countryCode: string;
}): Promise<{ error: string | null }> {
  return act("/admin/nodes", () => apiSend("/api/v1/admin/locations", input));
}

export async function removeLocation(locationId: string): Promise<{ error: string | null }> {
  return act("/admin/nodes", () =>
    apiSend(`/api/v1/admin/locations/${locationId}`, undefined, "DELETE"),
  );
}

/**
 * Déclare une machine.
 *
 * Rend le jeton du daemon : c'est lui qu'on recopie dans la configuration de
 * Wings, et l'écran l'affiche aussitôt. Il se relit ensuite dans le
 * `config.yml` du node, lecture réservée à l'administrateur et consignée
 * (PLAN §5.5).
 */
export async function createNode(input: {
  name: string;
  locationId: string;
  category: string;
  subcategory: string;
  fqdn: string;
  scheme: string;
  daemonPort: number;
  daemonSftpPort: number;
  memoryMb: number;
  diskMb: number;
  cpuCores: number;
  isPublic: boolean;
}): Promise<{
  error: string | null;
  /** Identifiant du node créé, pour enchaîner sans relire la liste. */
  id: string | null;
  token: { id: string; secret: string } | null;
}> {
  try {
    const { data } = await apiSendFor<{
      data: { id: string; tokenId: string; token: string };
    }>("/api/v1/admin/nodes", input);
    revalidatePath("/admin/nodes");
    // L'identifiant est rendu avec le jeton : l'écran en a besoin pour
    // enchaîner l'attribution à un revendeur sans relire la liste.
    return { error: null, id: data.id, token: { id: data.tokenId, secret: data.token } };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Création refusée.",
      id: null,
      token: null,
    };
  }
}

/* --- Répartition d'une machine entre revendeurs ---------------------------- */

/**
 * Lit les parts posées sur une machine.
 *
 * Une action serveur et non une lecture de page : la fenêtre de répartition
 * s'ouvre à la demande, et charger les parts de toutes les machines au
 * chargement de la liste ferait autant de calculs de consommation que de
 * machines, pour une fenêtre qu'on n'ouvrira pas.
 */
export async function loadNodeShares(nodeId: string): Promise<{
  error: string | null;
  shares: AdminNodeShare[];
}> {
  try {
    // `apiFetch` et non `apiSendFor` : c'est une lecture. `apiSendFor` n'accepte
    // que POST et DELETE, précisément pour qu'une lecture ne se déguise pas en
    // action.
    const { data } = await apiFetch<{ data: AdminNodeShare[] }>(
      `/api/v1/admin/nodes/${nodeId}/shares`,
    );
    return { error: null, shares: data };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Lecture refusée.",
      shares: [],
    };
  }
}

export async function setNodeShare(
  nodeId: string,
  input: { resellerId: string; memoryMb: number; diskMb: number; serversMax: number | null },
): Promise<{ error: string | null }> {
  return act("/admin/nodes", () => apiSend(`/api/v1/admin/nodes/${nodeId}/shares`, input));
}

export async function removeNodeShare(
  nodeId: string,
  resellerId: string,
): Promise<{ error: string | null }> {
  return act("/admin/nodes", () =>
    apiSend(`/api/v1/admin/nodes/${nodeId}/shares/${resellerId}`, undefined, "DELETE"),
  );
}

/**
 * Émet la clé d'amorçage affichée dans la commande `wings configure`.
 *
 * Appelée à l'ouverture de la fenêtre, et non au chargement de la page : une
 * clé, même bornée, ne se crée que lorsqu'on s'apprête à s'en servir. Ouvrir
 * la liste des nodes n'en sème pas une par ligne.
 *
 * Aucun `revalidatePath` : la page ne montre pas les clés, et la rafraîchir
 * refermerait la fenêtre qui vient de demander celle-ci.
 */
export async function issueNodeConfigureToken(
  nodeId: string,
): Promise<{ error: string | null; token: string | null; expiresAt: string | null }> {
  try {
    const { data } = await apiSendFor<{ data: { plaintext: string; expiresAt: string } }>(
      `/api/v1/admin/application-keys/node/${nodeId}`,
      {},
    );
    return { error: null, token: data.plaintext, expiresAt: data.expiresAt };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Émission refusée.",
      token: null,
      expiresAt: null,
    };
  }
}

/**
 * Le `config.yml` du node, à déposer sur la machine.
 *
 * Une action serveur et non une lecture de page : le fichier porte le jeton du
 * daemon en clair, et il n'a pas à être chargé — donc mis en cache par Next —
 * à chaque ouverture de la liste des nodes.
 */
export async function loadNodeConfiguration(
  nodeId: string,
): Promise<{ error: string | null; yaml: string | null }> {
  try {
    const { data } = await apiFetch<{ data: { yaml: string; tokenId: string } }>(
      `/api/v1/admin/nodes/${nodeId}/configuration`,
    );
    return { error: null, yaml: data.yaml };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Lecture refusée.", yaml: null };
  }
}

/**
 * Remplace le jeton du daemon.
 *
 * Le résultat est rendu tel quel, échec compris : « le daemon refuse les mises
 * à jour venues du panel » et « le daemon n'a pas répondu » se corrigent à deux
 * endroits différents, et les fondre en « échec » ferait chercher la panne du
 * mauvais côté.
 */
export async function rotateNodeToken(
  nodeId: string,
): Promise<{ error: string | null; applied: boolean }> {
  try {
    const { data } = await apiSendFor<{ data: { applied: boolean; failure: string | null } }>(
      `/api/v1/admin/nodes/${nodeId}/token/rotate`,
      {},
    );
    revalidatePath("/admin/nodes");
    return { error: data.failure, applied: data.applied };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Rotation refusée.", applied: false };
  }
}

export async function removeNode(nodeId: string): Promise<{ error: string | null }> {
  return act("/admin/nodes", () => apiSend(`/api/v1/admin/nodes/${nodeId}`, undefined, "DELETE"));
}

export async function setNodeMaintenance(
  nodeId: string,
  enabled: boolean,
): Promise<{ error: string | null }> {
  return act("/admin/nodes", () =>
    apiSend(`/api/v1/admin/nodes/${nodeId}/maintenance`, { enabled }),
  );
}

/**
 * Attribue un node à un revendeur, ou le rend à la plateforme.
 *
 * `null` est une valeur attendue et non un champ oublié : c'est ainsi qu'on
 * reprend une machine.
 */
export async function setNodeOwner(
  nodeId: string,
  ownerId: string | null,
): Promise<{ error: string | null }> {
  return act("/admin/nodes", () => apiSend(`/api/v1/admin/nodes/${nodeId}/owner`, { ownerId }));
}

export async function addNodeAllocations(
  nodeId: string,
  ip: string,
  from: number,
  to: number,
): Promise<{ error: string | null }> {
  return act("/admin/nodes", () =>
    apiSend(`/api/v1/admin/nodes/${nodeId}/allocations`, { ip, from, to }),
  );
}

export async function setEggEnabled(
  eggId: string,
  enabled: boolean,
): Promise<{ error: string | null }> {
  return act("/admin/eggs", () => apiSend(`/api/v1/admin/eggs/${eggId}/enabled`, { enabled }));
}

/**
 * Enregistre un egg modifié dans l'éditeur.
 *
 * Le brouillon a déjà été vérifié champ par champ à l'écran, avec le même
 * schéma (`EggDraft`). Ce qui peut encore être refusé ici dépend des serveurs
 * en service — une variable employée qu'on retire, par exemple — et le motif
 * de l'API est rendu tel quel : il nomme la variable et le nombre de serveurs.
 */
export async function saveEgg(eggId: string, draft: EggDraft): Promise<{ error: string | null }> {
  return act(`/admin/eggs/${eggId}`, async () => {
    await apiSend(`/api/v1/admin/eggs/${encodeURIComponent(eggId)}`, draft);
    revalidatePath("/admin/eggs");
  });
}

/**
 * L'export Pterodactyl d'un egg, prêt à être enregistré par le navigateur.
 *
 * Passé par une action plutôt que par un lien direct vers l'API : l'API n'est
 * pas exposée au navigateur sous le même nom, et la session voyage ici dans
 * le cookie que seul le serveur Next relaie.
 */
export async function exportEgg(
  eggId: string,
): Promise<{ error: string | null; filename: string; content: string }> {
  try {
    const { data } = await apiFetch<{ data: { filename: string; egg: unknown } }>(
      `/api/v1/admin/eggs/${encodeURIComponent(eggId)}/export`,
    );
    // Indenté sur quatre espaces, comme les exports de Pterodactyl.
    return { error: null, filename: data.filename, content: JSON.stringify(data.egg, null, 4) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Export refusé.",
      filename: "",
      content: "",
    };
  }
}

/**
 * Importe un export d'egg Pterodactyl collé dans le formulaire.
 *
 * Le JSON est analysé **ici**, avant l'envoi : un fichier tronqué au
 * copier-coller est le cas le plus fréquent, et le dire tout de suite vaut
 * mieux qu'un aller-retour pour s'entendre répondre « corps illisible ».
 */
export async function importEgg(raw: string, nest: string): Promise<{ error: string | null }> {
  let egg: unknown;
  try {
    egg = JSON.parse(raw);
  } catch {
    // Filet de sécurité : l'écran valide déjà le JSON, dans la langue du
    // lecteur. Ce message-ci ne devrait donc jamais s'afficher — mais l'action
    // reste appelable sans passer par l'écran.
    return { error: "Corps illisible : ce n'est pas du JSON." };
  }

  return act("/admin/eggs", () =>
    apiSend("/api/v1/admin/eggs/import", { egg, nest: nest.trim() || undefined }),
  );
}

/**
 * Importe un egg précis depuis le dépôt suivi.
 *
 * Rend le nom **déclaré par le fichier**, et non celui deviné depuis son
 * chemin : « egg-paper.json » donnait « Paper », le fichier dit « Paper ». La
 * différence se voit sur les eggs dont le fichier est nommé « config.json ».
 */
export async function importEggFromCatalogue(
  sourceId: string,
  path: string,
): Promise<{ error: string | null; name: string | null }> {
  try {
    const { data } = await apiSendFor<{ data: { id: string; name: string } }>(
      "/api/v1/admin/egg-catalogue/import",
      { sourceId, path },
    );
    revalidatePath("/admin/eggs");
    return { error: null, name: data.name };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Import refusé.", name: null };
  }
}

/**
 * Relit un dépôt d'eggs.
 *
 * Rend le compte rendu et non un simple succès : une synchronisation qui
 * annonce « terminé » sans chiffres laisse croire que tout est passé, alors
 * que le dépôt officiel contient des fichiers qui ne sont pas des eggs.
 */
export async function syncEggSource(sourceId: string): Promise<{
  error: string | null;
  report: {
    created: number;
    updated: number;
    skippedLocallyModified: number;
    failed: { ref: string; reason: string }[];
  } | null;
}> {
  try {
    const data = await apiSendFor<{
      data: {
        created: number;
        updated: number;
        skippedLocallyModified: number;
        failed: { ref: string; reason: string }[];
      };
    }>(`/api/v1/admin/egg-sources/${sourceId}/sync`, undefined);
    revalidatePath("/admin/eggs");
    return { error: null, report: data.data };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Synchronisation refusée.",
      report: null,
    };
  }
}

/**
 * Exécute une action et traduit son échec en message.
 *
 * L'erreur est renvoyée plutôt que levée : ces actions partent d'un tableau, et
 * un écran d'erreur complet pour une suspension refusée ferait perdre la liste
 * qu'on était en train de parcourir.
 */
async function act(path: string, call: () => Promise<void>): Promise<{ error: string | null }> {
  try {
    await call();
    revalidatePath(path);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Action refusée." };
  }
}

/**
 * Pose l'enveloppe de ressources d'un revendeur.
 *
 * Chaque dimension est un entier ou `null`, et `null` veut dire **sans
 * limite** : c'est ainsi qu'on retire un plafond. L'appel envoie donc toujours
 * les trois valeurs, y compris celles qui ne changent pas — un champ omis
 * serait refusé par l'API, précisément pour qu'un formulaire incomplet ne
 * puisse pas ouvrir la vanne par accident.
 */
export async function setResellerQuota(
  userId: string,
  quota: { memoryMb: number | null; diskMb: number | null; serversMax: number | null },
): Promise<{ error: string | null }> {
  return act("/admin/users", () => apiSend(`/api/v1/admin/users/${userId}/quota`, quota));
}

/** Un point de la courbe de charge d'un node. */
export interface NodeLoadPoint {
  t: number;
  memoryMb: number | null;
  cpuPct: number | null;
  /** Serveurs relevés sur ce pas : dit si la somme porte sur tout le node. */
  servers: number;
}

/**
 * Charge d'un node sur une fenêtre.
 *
 * Une action serveur et non une lecture de page : la fenêtre s'ouvre à la
 * demande, et charger la série de chaque machine au rendu de la liste ferait
 * autant d'agrégations que de nodes pour un graphe qu'on n'ouvrira pas.
 */
export async function loadNodeSeries(
  nodeId: string,
  window: string,
): Promise<{ error: string | null; points: NodeLoadPoint[] }> {
  try {
    const { data } = await apiFetch<{ data: NodeLoadPoint[] }>(
      `/api/v1/admin/nodes/${nodeId}/load?window=${encodeURIComponent(window)}`,
    );
    return { error: null, points: data };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Lecture refusée.", points: [] };
  }
}

/**
 * L'enveloppe d'un revendeur **et sa consommation du moment**.
 *
 * Lue à l'ouverture du formulaire, et pas avec la liste des comptes : elle
 * demande un relevé par serveur, ce qui n'a pas sa place dans un tableau de
 * plusieurs centaines de lignes. Ici, elle répond à la seule question qui
 * compte au moment de poser un chiffre — qu'est-ce que ce chiffre va faire.
 */
export async function fetchResellerQuotaReport(userId: string): Promise<ResellerQuotaReport> {
  const { data } = await apiFetch<{ data: ResellerQuotaReport }>(
    `/api/v1/admin/reseller-quotas/${userId}`,
  );
  return data;
}

/**
 * Change le propriétaire d'un serveur.
 *
 * Le rattachement au revendeur ne suit pas : il dit **qui héberge**, pas qui
 * possède. Un serveur qui change de mains ne change pas de machine — et le
 * déplacer fausserait l'enveloppe de deux revendeurs d'un coup.
 */
export async function setServerOwner(
  serverId: string,
  ownerId: string,
): Promise<{ error: string | null }> {
  try {
    await apiSendFor(`/api/v1/admin/servers/${serverId}/owner`, { ownerId });
    revalidatePath(`/admin/servers/${serverId}`);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Changement refusé." };
  }
}

/**
 * Change les limites d'un serveur.
 *
 * La fiche montrait ces chiffres depuis toujours, sans permettre d'y toucher :
 * un serveur naissait avec son offre et la gardait. Les faire monter passait
 * par la base, ou par une suppression suivie d'une recréation — c'est-à-dire
 * par la perte du volume du client.
 *
 * L'enveloppe du revendeur qui héberge s'applique **aussi** à l'administration :
 * un agrandissement fait sur sa machine est compté dans sa consommation, il
 * doit donc l'être dans son refus.
 */
export async function setServerLimits(
  serverId: string,
  limits: {
    memoryMb?: number;
    diskMb?: number;
    cpuPct?: number;
    swapMb?: number;
    backups?: number;
    databases?: number;
    allocations?: number;
  },
): Promise<{ error: string | null }> {
  try {
    await apiSendFor(`/api/v1/admin/servers/${serverId}/limits`, limits);
    revalidatePath(`/admin/servers/${serverId}`);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Changement refusé." };
  }
}
