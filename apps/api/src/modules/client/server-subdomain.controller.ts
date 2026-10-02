import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ActivityService } from "../activity/activity.service";
import { ImpersonationReadOnlyGuard, withImpersonator } from "../auth/impersonation.guard";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { SessionGuard } from "../auth/session.guard";
import { SubdomainsService } from "../dns/subdomains.service";
import { accessPrincipal, ServerAccessService } from "./server-access.service";

type ClientRequest = AuthenticatedRequest & { ip?: string };

/**
 * Le sous-domaine d'un serveur (PLAN §10.3).
 *
 * Mêmes permissions que les ports : c'est une adresse du serveur. La voir
 * demande `allocations.read`, la choisir ou la retirer `allocations.update`.
 */
@Controller("api/v1/client/servers/:id/subdomain")
@UseGuards(SessionGuard, ImpersonationReadOnlyGuard)
export class ServerSubdomainController {
  constructor(
    @Inject(ServerAccessService) private readonly access: ServerAccessService,
    @Inject(SubdomainsService) private readonly subdomains: SubdomainsService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  @Get()
  async show(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "allocations.read");
    return { data: await this.subdomains.stateFor(id) };
  }

  /**
   * Choisit le libellé, ou le change. L'ancien nom est retiré.
   *
   * Refusé pendant une suspension : un nom publié pour un serveur suspendu
   * occuperait la zone pour un service qui ne répond pas.
   */
  @Post()
  async choose(@Req() request: ClientRequest, @Param("id") id: string, @Body() body: unknown) {
    const label = (body as { label?: unknown } | null)?.label;
    if (typeof label !== "string" || label.length > 100) {
      throw new BadRequestException("Nom de sous-domaine invalide.");
    }
    await this.access.require(principalOf(request), id, "allocations.update");
    await this.access.requireOperable(id);
    const subdomain = await this.subdomains.claim(id, label);
    await this.log(request, id, "subdomain.set", { fqdn: subdomain.fqdn });
    return { data: subdomain };
  }

  @Delete()
  async remove(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "allocations.update");
    await this.subdomains.release(id);
    await this.log(request, id, "subdomain.remove", {});
    return { data: { removed: true } };
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

function principalOf(request: ClientRequest) {
  return accessPrincipal(request);
}
