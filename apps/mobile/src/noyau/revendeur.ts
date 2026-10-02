import type { ResellerClient, ResellerQuotaReport, ResellerServer } from "@gamedashboard/contracts";

/**
 * L'espace revendeur de l'application (ADR 0010, lot 5) : son enveloppe, ses
 * clients et leurs serveurs, la suspension, la consommation lue. Ce qui se
 * règle (marque, domaines, clés, limites) reste au navigateur.
 */

export type Dimension = "memoryMb" | "diskMb" | "servers";

export interface LigneEnveloppe {
  dimension: Dimension;
  utilise: number;
  /** `null` : sans limite. */
  limite: number | null;
  /** Ce qu'il reste, jamais négatif ; `null` sans limite. */
  reste: number | null;
  depasse: boolean;
}

/** L'enveloppe, dimension par dimension. */
export function enveloppe(rapport: ResellerQuotaReport): LigneEnveloppe[] {
  const lignes: [Dimension, number, number | null][] = [
    ["memoryMb", rapport.usage.memoryMb, rapport.quota.memoryMb],
    ["diskMb", rapport.usage.diskMb, rapport.quota.diskMb],
    ["servers", rapport.usage.servers, rapport.quota.serversMax],
  ];
  return lignes.map(([dimension, utilise, limite]) => ({
    dimension,
    utilise,
    limite,
    reste: limite === null ? null : Math.max(0, limite - utilise),
    depasse: limite !== null && utilise > limite,
  }));
}

/**
 * Un serveur en installation ou en transfert ne se suspend pas : l'API
 * refuserait (même règle que l'écran web).
 */
export function suspendable(serveur: Pick<ResellerServer, "state">): boolean {
  return serveur.state === null || serveur.state === "suspended";
}

export const estSuspendu = (serveur: Pick<ResellerServer, "state">) =>
  serveur.state === "suspended";

/**
 * Les serveurs d'un client. Le parc ne nomme le titulaire que par son
 * adresse : c'est elle qui rattache, sans tenir compte de la casse.
 */
export function serveursDuClient(
  serveurs: readonly ResellerServer[],
  client: Pick<ResellerClient, "email">,
): ResellerServer[] {
  const adresse = client.email.toLowerCase();
  return serveurs
    .filter((serveur) => serveur.ownerEmail.toLowerCase() === adresse)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Les clients, ceux qui ont le plus de serveurs d'abord, puis par nom. */
export function trierClients(clients: readonly ResellerClient[]): ResellerClient[] {
  return [...clients].sort((a, b) => b.servers - a.servers || a.name.localeCompare(b.name));
}

/* --- Consommation ------------------------------------------------------------ */

/** Un mois en jours UTC inclus : le mois courant (`decalage` 0) ou un précédent. */
export function periodeMois(maintenant: Date, decalage = 0): { from: string; to: string } {
  const debut = new Date(
    Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() - decalage, 1),
  );
  const finDuMois = new Date(Date.UTC(debut.getUTCFullYear(), debut.getUTCMonth() + 1, 0));
  const fin = decalage === 0 ? maintenant : finDuMois;
  return { from: jour(debut), to: jour(fin) };
}

const jour = (date: Date) => date.toISOString().slice(0, 10);

export interface ResumeServeur {
  serverId: string;
  nom: string;
  jours: number;
  /** Part des relevés où le serveur tournait, de 0 à 1 ; `null` sans relevé. */
  disponibilite: number | null;
  /** Moyenne du processeur sur les relevés, en pourcentage d'un cœur. */
  processeurMoyen: number | null;
  memoireMax: number;
  reseau: number;
  joueursMax: number | null;
  /** Une journée au moins n'a pas été relevée en entier. */
  incomplet: boolean;
}

const nombre = (valeur: unknown) =>
  typeof valeur === "number" && Number.isFinite(valeur) ? valeur : 0;

/**
 * Les journées de l'export, résumées par serveur. Les moyennes sont pondérées
 * par le nombre de relevés de chaque journée : un jour à moitié relevé ne
 * compte pas autant qu'un jour entier.
 */
export function resumerConsommation(jours: readonly Record<string, unknown>[]): ResumeServeur[] {
  const parServeur = new Map<
    string,
    ResumeServeur & { releves: number; enLigne: number; cpu: number }
  >();
  for (const ligne of jours) {
    const serverId = typeof ligne.serverId === "string" ? ligne.serverId : null;
    if (!serverId) continue;
    const courant = parServeur.get(serverId) ?? {
      serverId,
      nom: typeof ligne.serverName === "string" ? ligne.serverName : serverId,
      jours: 0,
      disponibilite: null,
      processeurMoyen: null,
      memoireMax: 0,
      reseau: 0,
      joueursMax: null,
      incomplet: false,
      releves: 0,
      enLigne: 0,
      cpu: 0,
    };
    const releves = nombre(ligne.samples);
    courant.jours += 1;
    courant.releves += releves;
    courant.enLigne += nombre(ligne.onlineSamples);
    courant.cpu += nombre(ligne.cpuAvgPct) * releves;
    courant.memoireMax = Math.max(courant.memoireMax, nombre(ligne.memoryMaxBytes));
    courant.reseau += nombre(ligne.networkRxBytes) + nombre(ligne.networkTxBytes);
    if (typeof ligne.playersMax === "number") {
      courant.joueursMax = Math.max(courant.joueursMax ?? 0, ligne.playersMax);
    }
    if (ligne.complete === false) courant.incomplet = true;
    parServeur.set(serverId, courant);
  }
  return [...parServeur.values()]
    .map(({ releves, enLigne, cpu, ...resume }) => ({
      ...resume,
      disponibilite: releves > 0 ? enLigne / releves : null,
      processeurMoyen: releves > 0 ? cpu / releves : null,
    }))
    .sort((a, b) => a.nom.localeCompare(b.nom));
}
