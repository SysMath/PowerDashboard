import type { PlatformAccess } from "./provisioning";
import type { IncidentImpact, IncidentState } from "./status";

/*
 * L'administration, telle que ses lectures la rendent (`/api/v1/admin/…`).
 *
 * Partagée par l'interface web et l'application mobile (ADR 0010, lot 6) :
 * une seule description, que les deux lisent.
 */

export interface AdminNode {
  id: string;
  name: string;
  category: string | null;
  subcategory: string | null;
  location: string;
  fqdn: string;
  memoryMb: number;
  diskMb: number;
  cpuCores: number;
  maintenance: boolean;
  wingsVersion: string | null;
  lastHeartbeatAt: string | null;
  /** Revendeur propriétaire. `null` vaut « la plateforme », pas « personne ». */
  ownerId: string | null;
  ownerName: string | null;
  servers: number;
  /**
   * Ce qui est **accordé** aux serveurs de la machine.
   *
   * Exact en toutes circonstances : il ne dépend d'aucun relevé, seulement de
   * ce que le panel a promis. C'est le chiffre qui répond à « puis-je en
   * placer un de plus ? », et zéro sur un node vide est une vérité.
   */
  allocatedMemoryMb: number;
  allocatedDiskMb: number;
  /**
   * Ce qui est **réellement consommé**, quand on a pu le relever.
   *
   * `null` tant qu'aucun serveur de la machine n'a de mesure fraîche. Distinct
   * de l'allocation, et les deux comptent : on vend des limites, les clients
   * en consomment une fraction.
   */
  measuredMemoryMb: number | null;
  measuredDiskMb: number | null;
  /** Combien de serveurs de la machine ont un relevé récent. */
  measuredServers: number;
}

export interface AdminServer {
  id: string;
  shortId: string;
  name: string;
  owner: string;
  ownerEmail: string;
  node: string;
  egg: string;
  /** État de gestion : installation, suspension, transfert. Nul en marche normale. */
  state: string | null;
  /**
   * État du conteneur au dernier relevé frais, ou `null` si aucun.
   *
   * Séparé de `state` parce que les deux répondent à deux questions : « que
   * fait le panel de ce serveur » et « que fait le serveur ». Les confondre
   * faisait afficher « État inconnu » sur un serveur mesuré chaque minute.
   */
  runtimeState: string | null;
  memoryMb: number;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  name: string;
  /** Les deux moitiés du nom, que la fiche de modification édite séparément. */
  nameFirst: string;
  nameLast: string;
  email: string;
  /** `null` tant que l'adresse n'est pas confirmée ; une adresse changée y revient. */
  emailVerifiedAt: string | null;
  locale: string;
  /** Compte suspendu depuis cet instant, ou `null` pour un compte actif. */
  suspendedAt: string | null;
  /** Motif interne, montré au support seulement. */
  suspensionReason: string | null;
  role: "admin" | "support" | "reseller" | "user";
  is2faEnabled: boolean;
  /**
   * Un revendeur autorise-t-il l'administration à créer des serveurs chez lui ?
   *
   * Sans objet pour les autres rôles, où la valeur ne décide de rien.
   */
  allowsPlatformProvisioning: boolean;
  lastLoginAt: string | null;
  servers: number;
  /**
   * Enveloppe du revendeur. `null` veut dire **sans limite** sur cette
   * dimension, jamais zéro — et zéro, posé sciemment, interdit toute création.
   *
   * Sans objet pour les autres rôles : l'API refuse d'en poser une.
   */
  /**
   * Ce que ce revendeur laisse la plateforme faire sur son parc. Sans objet
   * pour les autres rôles, où la valeur n'est pas lue.
   */
  platformAccess: PlatformAccess;
  quotaMemoryMb: number | null;
  quotaDiskMb: number | null;
  quotaServersMax: number | null;
}

export interface AdminIncidentUpdate {
  state: IncidentState;
  body: string;
  at: string;
}

export interface AdminIncident {
  id: string;
  title: string;
  state: IncidentState;
  impact: IncidentImpact;
  nodeIds: string[];
  updates: AdminIncidentUpdate[];
  startedAt: string;
  /** Nul tant que l'incident est ouvert. C'est ce champ qui le clôt, pas l'état. */
  resolvedAt: string | null;
}

/** Une ligne du journal de la plateforme (`GET /api/v1/admin/activity`). */
export interface AdminActivityEntry {
  id: string;
  event: string;
  actorLabel: string;
  actorType: "user" | "api_key" | "system";
  actorId: string | null;
  ip: string | null;
  properties: Record<string, unknown>;
  serverId: string | null;
  serverName: string | null;
  at: string;
}
