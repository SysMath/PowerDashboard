/**
 * Les arbres de dépôts d'eggs lus chez GitHub, gardés en mémoire.
 *
 * L'API de GitHub n'accorde que soixante appels par heure sans jeton, par
 * adresse : sur un hébergement mutualisé, d'autres les consomment aussi.
 * Chaque ouverture de l'écran des eggs ne doit pas en coûter un.
 *
 * - **Frais** (moins de `ttlMs`) : rendu sans appel.
 * - **Vieilli** : relu. Si la lecture échoue pour une raison **passagère**
 *   (limite d'appels, panne de GitHub, réseau, délai dépassé), l'arbre vieilli
 *   sert encore, marqué `stale`, tant qu'il a moins de `maxStaleMs`. Un dépôt
 *   d'eggs change peu, et une liste datée vaut mieux qu'un écran qui dit
 *   « injoignable ». Une erreur qui n'est pas passagère (dépôt ou branche
 *   introuvable) remonte : l'arbre gardé ne décrit plus rien d'importable.
 * - **Échec retenu** `failureHoldMs` : les lectures suivantes ne retentent
 *   pas GitHub, et répondent tout de suite. Sans cela, une sortie qui avale
 *   les paquets faisait attendre chaque ouverture de l'écran, et chaque geste
 *   qui le rafraîchit, jusqu'à l'échéance.
 * - **Absent** et lecture impossible : l'erreur remonte, et l'écran affiche
 *   son avertissement.
 *
 * Une synchronisation demandée ne passe pas par `read` : elle relit toujours
 * le dépôt, puis dépose l'arbre qu'elle a lu (`store`).
 */
export interface EggTree {
  paths: string[];
  /** Date de lecture chez GitHub, en millisecondes. */
  at: number;
  /** Arbre plus vieux que `ttlMs`, servi parce que GitHub n'a pas répondu. */
  stale: boolean;
}

export interface EggTreeCacheOptions {
  ttlMs: number;
  maxStaleMs: number;
  failureHoldMs: number;
  /** Un échec après lequel l'arbre vieilli peut encore servir. */
  transient: (error: unknown) => boolean;
  now?: () => number;
}

export class EggTreeCache {
  private readonly trees = new Map<string, { at: number; paths: string[] }>();
  private readonly failures = new Map<string, { at: number; error: unknown }>();
  private readonly now: () => number;

  constructor(private readonly options: EggTreeCacheOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async read(key: string, load: () => Promise<string[]>): Promise<EggTree> {
    const cached = this.trees.get(key);
    if (cached && this.now() - cached.at < this.options.ttlMs) {
      return { ...cached, stale: false };
    }

    const failure = this.failures.get(key);
    if (failure && this.now() - failure.at < this.options.failureHoldMs) {
      return this.fallback(key, failure.error);
    }

    let paths: string[];
    try {
      paths = await load();
    } catch (error) {
      if (!this.options.transient(error)) throw error;
      this.failures.set(key, { at: this.now(), error });
      return this.fallback(key, error);
    }
    return this.store(key, paths);
  }

  store(key: string, paths: string[]): EggTree {
    const tree = { at: this.now(), paths };
    this.trees.set(key, tree);
    this.failures.delete(key);
    return { ...tree, stale: false };
  }

  private fallback(key: string, error: unknown): EggTree {
    const cached = this.trees.get(key);
    if (cached && this.now() - cached.at < this.options.maxStaleMs) {
      return { ...cached, stale: true };
    }
    throw error;
  }
}
