import { SnapshotName } from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ActivityService } from "../activity/activity.service";
import { AdminGuard } from "../admin/admin.guard";
import type { AdminRequest } from "../admin/admin-input";
import { AdminWriteGuard } from "../admin/admin-write.guard";
import { StaffTwoFactorGuard } from "../admin/staff-2fa.guard";
import { SessionGuard } from "../auth/session.guard";
import { NodeCapabilitiesService } from "../node-agent/node-capabilities.service";
import { SnapshotPolicyService } from "./snapshot-policy.service";
import { SnapshotsService } from "./snapshots.service";

const NODE_ID = new ParseUUIDPipe({
  exceptionFactory: () => new NotFoundException("Node introuvable."),
});

/**
 * Administration des instantanés (ADR 0009, « Tout se règle dans
 * l'interface ») : valeurs par défaut, réglages d'un node, registre et
 * destruction. Chaque changement de réglage est consigné avec l'avant et
 * l'après.
 */
@Controller("api/v1/admin")
@UseGuards(SessionGuard, AdminGuard, StaffTwoFactorGuard)
export class AdminSnapshotsController {
  constructor(
    @Inject(SnapshotsService) private readonly snapshots: SnapshotsService,
    @Inject(SnapshotPolicyService) private readonly policies: SnapshotPolicyService,
    @Inject(NodeCapabilitiesService) private readonly capabilities: NodeCapabilitiesService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  @Get("snapshots/defaults")
  async defaults() {
    return { data: await this.policies.defaults() };
  }

  @Put("snapshots/defaults")
  @UseGuards(AdminWriteGuard)
  async saveDefaults(@Req() request: AdminRequest, @Body() body: unknown) {
    const before = await this.policies.defaults();
    const after = await this.policies.saveDefaults(body);
    await this.log(request, "admin.snapshot_defaults_updated", { before, after });
    return { data: after };
  }

  @Get("nodes/:nodeId/snapshots")
  async node(@Param("nodeId", NODE_ID) nodeId: string) {
    const [policy, status, capabilities, snapshots] = await Promise.all([
      this.policies.forNode(nodeId),
      this.snapshots.status(nodeId),
      this.capabilities.forNode(nodeId),
      this.snapshots.listForNode(nodeId),
    ]);
    return {
      data: { ...policy, status, capability: capabilities.instantanes, snapshots },
    };
  }

  /** `{ policy }` pour des réglages propres, `{ policy: null }` pour suivre les défauts. */
  @Put("nodes/:nodeId/snapshots/policy")
  @UseGuards(AdminWriteGuard)
  async savePolicy(
    @Req() request: AdminRequest,
    @Param("nodeId", NODE_ID) nodeId: string,
    @Body() body: unknown,
  ) {
    if (typeof body !== "object" || body === null || !("policy" in body)) {
      throw new BadRequestException("Corps attendu : { policy } ou { policy: null }.");
    }
    const before = await this.policies.forNode(nodeId);
    let after: Awaited<ReturnType<SnapshotPolicyService["forNode"]>>;
    try {
      after = await this.policies.saveForNode(nodeId, (body as { policy: unknown }).policy);
    } catch (error) {
      // Clé étrangère : le node n'existe pas.
      if ((error as { cause?: { code?: string } }).cause?.code === "23503") {
        throw new NotFoundException("Node introuvable.");
      }
      throw error;
    }
    await this.log(request, "admin.snapshot_policy_updated", { nodeId, before, after });
    return { data: after };
  }

  /** L'agent détruit l'instantané à son relevé suivant ; ses épinglages tombent. */
  @Delete("nodes/:nodeId/snapshots/:name")
  @UseGuards(AdminWriteGuard)
  @HttpCode(202)
  async destroy(
    @Req() request: AdminRequest,
    @Param("nodeId", NODE_ID) nodeId: string,
    @Param("name") raw: string,
  ) {
    const name = SnapshotName.safeParse(raw);
    if (!name.success) throw new BadRequestException("Nom d'instantané invalide.");
    const receipt = await this.snapshots.destroy(nodeId, name.data, request.user.id);
    if (!receipt.existing) {
      await this.log(request, "admin.snapshot_destroyed", { nodeId, name: name.data });
    }
    return { data: receipt };
  }

  private async log(request: AdminRequest, event: string, properties: Record<string, unknown>) {
    await this.activity.record({
      event,
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties,
    });
  }
}
