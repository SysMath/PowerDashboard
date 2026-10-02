import {
  DEFAULT_SNAPSHOT_POLICY,
  resolveSnapshotPolicy,
  SNAPSHOT_DEFAULTS_SETTING_KEY,
  SnapshotPolicy,
} from "@gamedashboard/contracts";
import { type Database, nodeSnapshots, settings } from "@gamedashboard/db";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";

export interface NodePolicyView {
  policy: SnapshotPolicy;
  /** Faux : le node suit les valeurs par défaut de la plateforme. */
  custom: boolean;
}

/**
 * Réglages des instantanés : valeurs par défaut de la plateforme, et réglages
 * propres à un node qui les remplacent en bloc.
 *
 * Les défauts vivent dans `settings`, hors du catalogue des réglages, comme
 * les presets de sous-utilisateurs : c'est une structure, pas un champ de
 * formulaire. Un node sans réglage propre suit les défauts, y compris ceux
 * changés plus tard.
 */
@Injectable()
export class SnapshotPolicyService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async defaults(): Promise<SnapshotPolicy> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SNAPSHOT_DEFAULTS_SETTING_KEY))
      .limit(1);
    return row ? resolveSnapshotPolicy(row.value) : DEFAULT_SNAPSHOT_POLICY;
  }

  async saveDefaults(input: unknown): Promise<SnapshotPolicy> {
    const policy = parse(input);
    await this.db
      .insert(settings)
      .values({ key: SNAPSHOT_DEFAULTS_SETTING_KEY, value: policy, isSecret: false })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: policy, isSecret: false, updatedAt: new Date().toISOString() },
      });
    return policy;
  }

  async forNode(nodeId: string): Promise<NodePolicyView> {
    const [row] = await this.db
      .select({ policy: nodeSnapshots.policy })
      .from(nodeSnapshots)
      .where(eq(nodeSnapshots.nodeId, nodeId))
      .limit(1);
    if (row?.policy != null) return { policy: resolveSnapshotPolicy(row.policy), custom: true };
    return { policy: await this.defaults(), custom: false };
  }

  /** `null` rend le node aux valeurs par défaut. */
  async saveForNode(nodeId: string, input: unknown | null): Promise<NodePolicyView> {
    const policy = input === null ? null : parse(input);
    const now = new Date().toISOString();
    await this.db
      .insert(nodeSnapshots)
      .values({ nodeId, policy })
      .onConflictDoUpdate({ target: nodeSnapshots.nodeId, set: { policy, updatedAt: now } });
    return this.forNode(nodeId);
  }
}

function parse(input: unknown): SnapshotPolicy {
  const parsed = SnapshotPolicy.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.issues[0]?.message ?? "Réglages invalides.");
  }
  return parsed.data;
}
