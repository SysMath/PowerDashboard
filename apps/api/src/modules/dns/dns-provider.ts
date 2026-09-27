import type { DesiredRecord, DnsProviderKind } from "@gamedashboard/contracts";

/**
 * Ce qu'un fournisseur DNS doit savoir faire pour le panel.
 *
 * Même découpage que `BillingProvider` : chaque fournisseur traduit son
 * protocole, et `SubdomainsService` garde pour lui ce qui ne doit pas varier
 * d'un fournisseur à l'autre — le choix des enregistrements, la vérification
 * du nom, le retrait de ce qui a été publié et rien d'autre.
 *
 * Une implémentation **lève** `DnsRefusal` quand le fournisseur refuse ou
 * répond en erreur, et une erreur ordinaire quand il ne répond pas du tout.
 */
export interface DnsProvider {
  readonly kind: DnsProviderKind;

  /** Le nom de la zone, ce qui prouve à la fois le jeton et l'identifiant. */
  zoneName(connection: DnsConnection): Promise<string>;

  /** Les enregistrements de la zone portant exactement ce nom, quel qu'en soit le type. */
  recordsNamed(connection: DnsConnection, name: string): Promise<NamedRecord[]>;

  create(connection: DnsConnection, record: DesiredRecord, note: string): Promise<ProviderRecord>;

  /** Remplace un enregistrement. Absent chez le fournisseur : `DnsRefusal` de raison `missing`. */
  update(
    connection: DnsConnection,
    id: string,
    record: DesiredRecord,
    note: string,
  ): Promise<ProviderRecord>;

  /** Retire un enregistrement. Un enregistrement déjà absent n'est pas une erreur. */
  remove(connection: DnsConnection, id: string): Promise<void>;
}

/** Les réglages `dns.*`, relus et déchiffrés à chaque usage. */
export interface DnsConnection {
  zoneId: string;
  apiToken: string;
}

/** Un enregistrement lu dans la zone : son identifiant, son type, et la note qu'il porte. */
export interface NamedRecord {
  id: string;
  type: string;
  /** Le nom demandé : le fournisseur n'en rend pas d'autre. */
  name: string;
  note: string | null;
}

/** Un enregistrement tel que le fournisseur l'a rangé : ce qu'on voulait, et son identifiant. */
export type ProviderRecord = DesiredRecord & { id: string };

/**
 * Pourquoi le fournisseur a refusé :
 *
 * - `forbidden` : jeton refusé, ou sans droit sur cette zone ;
 * - `missing` : l'enregistrement visé n'existe pas (retiré à la main) ;
 * - `down` : le fournisseur répond en erreur (5xx) ;
 * - `refused` : tout autre refus (nom en conflit, valeur invalide).
 */
export type DnsRefusalReason = "forbidden" | "missing" | "down" | "refused";

/**
 * Le fournisseur a répondu, mais pour refuser. Sa phrase va au journal et à
 * l'administration, **jamais au client** : elle peut nommer la zone, le compte
 * ou un détail de la configuration.
 */
export class DnsRefusal extends Error {
  constructor(
    message: string,
    readonly reason: DnsRefusalReason = "refused",
  ) {
    super(message);
  }
}
