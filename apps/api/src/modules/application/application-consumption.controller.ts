import { Controller, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";
import { ConsumptionService } from "../consumption/consumption.service";
import { consumptionPageRequest } from "../consumption/consumption-http";
import { ApplicationGuard, type ApplicationRequest, RequireScopes } from "./application.guard";

/**
 * Consommation journalière des serveurs, pour un facturier (PLAN §10.3).
 *
 * En JSON paginé, mille journées par page, dans l'ordre (jour, serveur) :
 * `meta.hasMore` dit s'il faut demander la page suivante. Le CSV reste à
 * l'écran ; un programme lit du JSON.
 *
 * Une clé de revendeur ne lit que les journées où **il** hébergeait le
 * serveur : filtrer par un serveur ou un client qui n'est pas à lui rend une
 * liste vide, jamais les journées d'un autre.
 */
@Controller("api/v1/application")
@UseGuards(ApplicationGuard)
export class ApplicationConsumptionController {
  constructor(@Inject(ConsumptionService) private readonly consumption: ConsumptionService) {}

  @Get("consumption")
  @RequireScopes("consumption.read")
  async list(@Req() request: ApplicationRequest, @Query() query: Record<string, unknown>) {
    const { period, page, serverId, ownerId } = consumptionPageRequest(query);
    const resellerId = request.application.resellerId;
    const result = await this.consumption.page(
      { period, serverId, ownerId, ...(resellerId === null ? {} : { scope: { resellerId } }) },
      page,
    );
    return {
      data: result.items,
      meta: { from: period.from, to: period.to, page, hasMore: result.hasMore },
    };
  }
}
