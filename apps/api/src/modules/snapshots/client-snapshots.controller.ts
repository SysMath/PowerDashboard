import { SnapshotName, SnapshotPinInput } from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ActivityService } from "../activity/activity.service";
import { ImpersonationReadOnlyGuard, withImpersonator } from "../auth/impersonation.guard";
import { type AuthenticatedRequest, SessionGuard } from "../auth/session.guard";
import { accessPrincipal, ServerAccessService } from "../client/server-access.service";
import { SnapshotsService } from "./snapshots.service";

type ClientRequest = AuthenticatedRequest & {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

function principalOf(request: ClientRequest) {
  return accessPrincipal(request);
}

function snapshotName(raw: string): string {
  const parsed = SnapshotName.safeParse(raw);
  if (!parsed.success) throw new BadRequestException("Nom d'instantané invalide.");
  return parsed.data;
}

/**
 * Onglet « Instantanés » d'un serveur (ADR 0009), par session ou jeton
 * personnel, sous les permissions `snapshots.*`.
 *
 * Tout passe par `SnapshotsService`, qui consulte `nodeCapabilities()` : sur
 * un node sans agent ou sans la fonction, ces routes répondent 404 comme
 * l'onglet est absent.
 */
@Controller("api/v1/client/servers/:id/snapshots")
@UseGuards(SessionGuard, ImpersonationReadOnlyGuard)
export class ClientSnapshotsController {
  constructor(
    @Inject(ServerAccessService) private readonly access: ServerAccessService,
    @Inject(SnapshotsService) private readonly snapshots: SnapshotsService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  @Get()
  async list(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "snapshots.read");
    return this.snapshots.listForServer(id);
  }

  /** Pris par l'agent à son relevé suivant : 202, et l'ordre à suivre. */
  @Post()
  @HttpCode(202)
  async take(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "snapshots.create");
    await this.access.requireOperable(id);
    const receipt = await this.snapshots.take(id, request.user.id);
    if (!receipt.existing) {
      await this.log(request, id, "snapshot.create", { orderId: receipt.orderId });
    }
    return { data: receipt };
  }

  @Post(":name/pin")
  async pin(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("name") raw: string,
    @Body() body: unknown,
  ) {
    const name = snapshotName(raw);
    const input = SnapshotPinInput.safeParse(body ?? {});
    if (!input.success) throw new BadRequestException("Libellé invalide (80 caractères au plus).");
    await this.access.require(principalOf(request), id, "snapshots.create");
    // Comme prendre et restaurer : rien sur un serveur suspendu, en
    // installation ou en restauration.
    await this.access.requireOperable(id);
    const label = input.data.label ? input.data.label : null;
    await this.snapshots.pin(id, name, label, request.user.id);
    await this.log(request, id, "snapshot.pin", { name, label });
    return { data: { name, pinned: true } };
  }

  /**
   * Restaure le serveur depuis cet instantané : 202 aussitôt, le serveur
   * s'arrête, l'agent prend un instantané de sûreté puis recopie. Le
   * serveur reste arrêté ensuite.
   */
  @Post(":name/restore")
  @HttpCode(202)
  async restore(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("name") raw: string,
  ) {
    const name = snapshotName(raw);
    await this.access.require(principalOf(request), id, "snapshots.restore");
    await this.access.requireOperable(id);
    const receipt = await this.snapshots.restore(id, name, request.user.id);
    await this.log(request, id, "snapshot.restore", { name, orderId: receipt.orderId });
    return { data: receipt };
  }

  @Delete(":name/pin")
  async unpin(@Req() request: ClientRequest, @Param("id") id: string, @Param("name") raw: string) {
    const name = snapshotName(raw);
    await this.access.require(principalOf(request), id, "snapshots.create");
    await this.access.requireOperable(id);
    await this.snapshots.unpin(id, name);
    await this.log(request, id, "snapshot.unpin", { name });
    return { data: { name, pinned: false } };
  }

  private async log(
    request: ClientRequest,
    serverId: string,
    event: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await this.activity.record({
      event,
      serverId,
      actorId: request.user.id,
      actorType: request.scopes === null ? "user" : "api_key",
      actorLabel: await this.activity.labelFor(request.user.id),
      ip: request.ip ?? null,
      properties: withImpersonator(request, properties),
    });
  }
}
