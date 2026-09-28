import { SERVER_CONSUMPTION_COLUMNS } from "@gamedashboard/contracts";
import { Controller, Get, Inject, Param, Query, Req, Res, UseGuards } from "@nestjs/common";
import { requestOrigin } from "../../common/request-origin";
import { ImpersonationReadOnlyGuard } from "../auth/impersonation.guard";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { SessionGuard } from "../auth/session.guard";
import { ConsumptionService } from "../consumption/consumption.service";
import {
  consumptionExportRequest,
  type DownloadReply,
  sendConsumptionFile,
} from "../consumption/consumption-http";
import { ServerAccessService } from "./server-access.service";

/**
 * Consommation journalière d'un serveur, à télécharger (PLAN §10.3).
 *
 * Même permission que l'historique des mesures, `console.read` : ce sont les
 * mêmes relevés, résumés par jour.
 *
 * Les colonnes qui nomment des comptes sont retirées : un sous-utilisateur, ou
 * le titulaire d'après un transfert, lit ce que ce serveur a consommé, pas
 * l'adresse de celui qui le possédait avant lui.
 */
@Controller("api/v1/client/servers/:id")
@UseGuards(SessionGuard, ImpersonationReadOnlyGuard)
export class ServerConsumptionController {
  constructor(
    @Inject(ServerAccessService) private readonly access: ServerAccessService,
    @Inject(ConsumptionService) private readonly consumption: ConsumptionService,
  ) {}

  @Get("consumption/export")
  async export(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
    @Res() reply: DownloadReply,
  ): Promise<void> {
    const { period, format } = consumptionExportRequest(query);

    await this.access.require(
      { id: request.user.id, scopes: request.scopes, origin: requestOrigin(request) },
      id,
      "console.read",
    );

    sendConsumptionFile(
      reply,
      this.consumption.exportFile(
        { period, scope: { serverId: id } },
        format,
        SERVER_CONSUMPTION_COLUMNS,
      ),
    );
  }
}
