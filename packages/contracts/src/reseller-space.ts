import type { PlatformAccess } from "./provisioning";

/*
 * L'espace revendeur, tel que `GET /api/v1/reseller/overview` le rend.
 *
 * Partagé par l'interface web et l'application mobile (ADR 0010, lot 5) :
 * une seule description, que les deux lisent.
 */

/**
 * Une machine du revendeur — entière, ou par tranche.
 *
 * Deux façons de lui confier du matériel, et l'écran doit les distinguer : un
 * VPS entier, ou une part sur un dédié qu'il partage avec d'autres revendeurs.
 * Les chiffres ci-dessous sont **les siens**, jamais ceux de la machine :
 * annoncer 128 Go à quelqu'un qui en détient 32 l'inviterait à en vendre
 * quatre fois trop, et la charge totale d'un dédié partagé révélerait
 * l'activité de ses concurrents.
 */
export interface ResellerNode {
  id: string;
  name: string;
  fqdn: string;
  location: string;
  maintenance: boolean;
  /** Sa capacité sur cette machine : la machine entière, ou sa part. */
  memoryMb: number;
  diskMb: number;
  /** Nul sur une part : les cœurs ne se découpent pas. */
  cpuCores: number | null;
  /** Ce que **lui** consomme ici, jamais la charge de la machine. */
  usedMemoryMb: number;
  usedDiskMb: number;
  servers: number;
  freePorts: number;
  totalPorts: number;
  lastHeartbeatAt: string | null;
  /** Comment la machine lui est confiée. */
  tenancy: "dedicated" | "shared";
  /**
   * Comment la consommation a été obtenue : relevée, ou majorée par les
   * limites faute de mesure. Un plafond comparé à une estimation n'autorise
   * pas les mêmes décisions qu'un plafond comparé à un relevé, donc l'écran
   * le dit.
   */
  usageBasis: "measured" | "estimated" | "partial";
}

export interface ResellerServer {
  id: string;
  shortId: string;
  name: string;
  owner: string;
  ownerEmail: string;
  node: string;
  egg: string;
  state: string | null;
  memoryMb: number;
  diskMb: number;
  cpuPct: number;
  swapMb: number;
  backupLimit: number;
  databaseLimit: number;
  allocationLimit: number;
  createdAt: string;
}

export interface ResellerClient {
  id: string;
  name: string;
  email: string;
  servers: number;
  memoryMb: number;
}

/**
 * L'enveloppe accordée au revendeur, et ce qu'il en consomme.
 *
 * `null` sur une dimension vaut **sans limite**, jamais zéro : c'est l'état de
 * tout revendeur à qui l'administration n'a rien posé.
 *
 * La consommation compte les serveurs des machines du revendeur *et* les
 * siens ailleurs, sans double compte. Elle peut donc dépasser la capacité
 * d'un seul node, et c'est normal.
 */
export interface ResellerQuotaReport {
  quota: {
    memoryMb: number | null;
    diskMb: number | null;
    serversMax: number | null;
  };
  usage: {
    memoryMb: number;
    diskMb: number;
    servers: number;
    /**
     * Ce que le chiffre vaut.
     *
     * Décisif depuis que le surveillant coupe sur l'enveloppe : faute de
     * relevé, la consommation est majorée par les limites accordées, et le
     * surveillant refuse d'agir dessus. Le même dépassement annonce donc une
     * coupure ou rien du tout, selon ce champ.
     */
    basis: "measured" | "estimated" | "partial";
    /** Serveurs dont la consommation n'a pas pu être relevée. */
    unmeasured: number;
  };
}

export interface ResellerOverview {
  nodes: ResellerNode[];
  servers: ResellerServer[];
  clients: ResellerClient[];
  /**
   * Ce que ce revendeur laisse la plateforme faire sur son parc.
   *
   * Remplace un booléen qui ne bloquait que la création : l'administration
   * gardait la console, les fichiers et la suppression de tous ses serveurs.
   */
  platformAccess: PlatformAccess;
  quota: ResellerQuotaReport;
}
