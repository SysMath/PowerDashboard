import type { AdminNode, AdminServer, AdminUser, RolePresetsView } from "@gamedashboard/contracts";
import { notFound } from "next/navigation";
import { ApiError, apiFetch } from "./client";

export type { AdminNode, AdminServer, AdminUser } from "@gamedashboard/contracts";

/**
 * Lectures de l'espace d'administration.
 *
 * Aucune n'est mise en cache : `apiFetch` impose `no-store`. Une page
 * d'administration servie depuis un cache montrerait l'infrastructure telle
 * qu'elle était, ce qui est exactement l'inverse de son usage — on l'ouvre
 * quand quelque chose ne va pas.
 */

export interface AdminEgg {
  id: string;
  name: string;
  nest: string;
  description: string | null;
  image: string;
  enabled: boolean;
  updatedAt: string;
  servers: number;
}

/**
 * Classement des nodes, tel qu'il est déclaré en base.
 *
 * `nodes` compte les machines réellement rangées sous cet intitulé : c'est la
 * question qu'on se pose avant de supprimer une catégorie.
 */
export interface AdminNodeCategory {
  id: string;
  name: string;
  description: string | null;
  position: number;
  nodes: number;
}

export interface AdminNodeSubcategory {
  id: string;
  categoryId: string;
  name: string;
  position: number;
  nodes: number;
}

export interface AdminNodeTaxonomy {
  categories: AdminNodeCategory[];
  subcategories: AdminNodeSubcategory[];
}

export const fetchNodeTaxonomy = () => unwrap<AdminNodeTaxonomy>("/api/v1/admin/node-taxonomy");

/**
 * Part d'un revendeur sur une machine, avec ce qu'elle occupe réellement.
 *
 * `usage.basis` dit d'où vient le chiffre : relevé sur les serveurs, ou majoré
 * par leurs limites faute de mesure. L'écran doit pouvoir le signaler — un
 * plafond comparé à une estimation n'autorise pas les mêmes décisions.
 */
export interface AdminNodeShare {
  id: string;
  nodeId: string;
  nodeName: string;
  resellerId: string;
  resellerName: string;
  memoryMb: number;
  diskMb: number;
  serversMax: number | null;
  usage: {
    memoryMb: number;
    diskMb: number;
    servers: number;
    basis: "measured" | "estimated" | "partial";
    unmeasured: number;
  };
}

export const fetchNodeShares = (nodeId: string) =>
  unwrap<AdminNodeShare[]>(`/api/v1/admin/nodes/${nodeId}/shares`);

export interface AdminLocation {
  id: string;
  short: string;
  long: string;
  countryCode: string;
}

export const fetchLocations = () => unwrap<AdminLocation[]>("/api/v1/admin/locations");

/**
 * Le dépôt suivi, et ce qu'il propose.
 *
 * `installedId` non nul : l'egg est déjà dans le catalogue local. Le dire évite
 * de proposer un import qui ne ferait que réécrire ce qui est là.
 */
export interface EggCatalogueSource {
  id: string;
  name: string;
  url: string;
  branch: string;
}

export interface EggCatalogueEntry {
  path: string;
  name: string;
  group: string;
  installedId: string | null;
  enabled: boolean;
}

export const fetchEggCatalogue = () =>
  unwrap<{
    source: EggCatalogueSource;
    entries: EggCatalogueEntry[];
    /** Date de lecture de l'arbre du dépôt chez GitHub. */
    readAt: string;
    /** Arbre vieilli, servi parce que GitHub n'a pas répondu. */
    stale: boolean;
  }>("/api/v1/admin/egg-catalogue");

/** Le catalogue du dépôt, ou la raison pour laquelle il manque. */
export interface EggCatalogueRead {
  source: EggCatalogueSource | null;
  entries: EggCatalogueEntry[];
  /** Liste servie de mémoire, lue chez GitHub à `readAt`. */
  staleSince: string | null;
  /**
   * Catalogue absent. `reason` : la phrase de l'API quand elle en donne une ;
   * nulle quand l'API n'a pas répondu ou n'a rien dit d'utile — l'écran
   * l'explique alors lui-même, sans l'adresse interne de l'API.
   */
  error: { reason: string | null } | null;
}

/**
 * Le catalogue du dépôt, **sans faire tomber la page** quand il manque.
 *
 * Il se lit chez GitHub : limite d'appels anonymes atteinte (soixante par
 * heure et par adresse, vite consommées sur un hébergement mutualisé), sortie
 * filtrée, GitHub en panne. Un seul de ces refus remplaçait tout l'écran des
 * eggs par « Une erreur est survenue » : plus moyen de modifier, activer ou
 * coller un egg local, alors que rien de cela ne dépend du dépôt. Le refus
 * devient ici un avertissement, et le reste de l'écran continue de servir.
 *
 * Seul un refus de l'API est absorbé. Ce qui n'en est pas un — le « page
 * introuvable » qu'`unwrap` lève pour une session qui n'est plus du personnel —
 * suit son cours.
 */
export async function readEggCatalogue(read = fetchEggCatalogue): Promise<EggCatalogueRead> {
  try {
    const { source, entries, readAt, stale } = await read();
    return { source, entries, staleSince: stale ? readAt : null, error: null };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const parlante = error.kind === "http" && error.status !== 500;
    return {
      source: null,
      entries: [],
      staleSince: null,
      error: { reason: parlante ? error.message : null },
    };
  }
}

export interface AdminOverview {
  servers: number;
  users: number;
  nodes: number;
  allocationsFree: number;
}

/**
 * Lecture d'une route d'administration, **avec la conclusion du refus**.
 *
 * Toutes les routes de ce fichier sont gardées côté API. Un refus ne dit donc
 * qu'une chose : la session n'est pas, ou n'est plus, celle d'un membre du
 * personnel. La coquille en tire déjà cette conclusion et rend un 404 — mais
 * une page et sa mise en page se rendent **en parallèle** dans Next, si bien
 * que le chargement partait quand même et échouait sur une exception brute.
 *
 * C'est ce qui se voyait à la prise en main : au moment où l'agent devient son
 * client, la page d'administration encore affichée refait son appel, et
 * l'écran d'erreur arrivait avant la redirection. Les deux disent désormais la
 * même chose, et l'espace cesse simplement d'exister pour qui n'y a plus droit.
 */
const unwrap = async <T>(path: string): Promise<T> => {
  try {
    return (await apiFetch<{ data: T }>(path)).data;
  } catch (error) {
    // 401, 403, 404 : trois façons de dire « pas pour vous ». Les autres pannes
    // — API éteinte, erreur interne — doivent rester visibles, elles appellent
    // un diagnostic et non une page introuvable.
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) notFound();
    throw error;
  }
};

export const fetchAdminOverview = () => unwrap<AdminOverview>("/api/v1/admin/overview");
export const fetchAdminNodes = () => unwrap<AdminNode[]>("/api/v1/admin/nodes");
export const fetchAdminServers = () => unwrap<AdminServer[]>("/api/v1/admin/servers");
export const fetchAdminUsers = () => unwrap<AdminUser[]>("/api/v1/admin/users");
export const fetchAdminEggs = () => unwrap<AdminEgg[]>("/api/v1/admin/eggs");

/** Une variable d'egg, avec le nombre de serveurs qui lui ont une valeur. */
export interface AdminEggVariable {
  id: string;
  name: string;
  envVariable: string;
  description: string | null;
  defaultValue: string;
  userViewable: boolean;
  userEditable: boolean;
  rules: string;
  servers: number;
}

/** L'egg complet, tel que l'éditeur le reçoit. */
export interface AdminEggDetail {
  id: string;
  nest: string;
  name: string;
  description: string | null;
  author: string | null;
  dockerImages: Record<string, string>;
  startup: string;
  configFiles: unknown;
  configStartup: unknown;
  configStop: string | null;
  configLogs: unknown;
  installScript: string;
  installContainer: string;
  installEntrypoint: string;
  features: string[];
  fileDenylist: string[];
  /** Commandes du jeu proposées à la console (`say <message>`). */
  consoleCommands: string[];
  enabled: boolean;
  locallyModified: boolean;
  sourceRef: string | null;
  servers: number;
  variables: AdminEggVariable[];
}

export const fetchAdminEgg = (eggId: string) =>
  unwrap<AdminEggDetail>(`/api/v1/admin/eggs/${encodeURIComponent(eggId)}`);

/**
 * Un secret n'a pas de `value` : l'API ne renvoie qu'un « configuré ou non ».
 * Le type le rend impossible à oublier — il n'existe aucun champ où la valeur
 * pourrait se glisser par mégarde.
 */
export type SettingValue =
  | { key: string; kind: "text" | "number" | "boolean"; value: string | number | boolean }
  | { key: string; kind: "secret"; isConfigured: boolean };

export interface FeatureFlagValue {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
}

export interface PlatformSettings {
  values: SettingValue[];
  flags: FeatureFlagValue[];
}

export const fetchPlatformSettings = () => unwrap<PlatformSettings>("/api/v1/admin/settings");

/** Ce qu'une table a rendu au dernier tour de rétention. */
export interface RetentionTableReport {
  table: string;
  rows: number;
  days: number;
  reason: string;
}

/**
 * État du service de rétention.
 *
 * Lu pour une seule raison : **un service muet ne se distingue pas d'un service
 * mort**. Celui-ci n'écrivait au journal que lorsqu'il effaçait quelque chose,
 * donc jamais sur une plateforme jeune.
 */
export interface RetentionReport {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  durationMs: number | null;
  nextRunAt: string | null;
  tables: RetentionTableReport[];
  lastRemoved: number;
  totalRemoved: number;
  failure: { message: string; consecutive: number } | null;
}

export const fetchRetention = () => unwrap<RetentionReport>("/api/v1/admin/maintenance/retention");

/**
 * Presets de sous-utilisateurs : ceux en vigueur, ceux du code, et lesquels
 * s'en écartent.
 */
export const fetchSubuserPresets = () => unwrap<RolePresetsView>("/api/v1/admin/subuser-presets");
