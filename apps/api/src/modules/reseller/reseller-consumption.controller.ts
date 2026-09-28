import { CONSUMPTION_COLUMNS } from "@gamedashboard/contracts";
import { Controller, Get, Inject, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ActivityService } from "../activity/activity.service";
import { StaffTwoFactorGuard } from "../admin/staff-2fa.guard";
import { ImpersonationReadOnlyGuard } from "../auth/impersonation.guard";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { SessionGuard } from "../auth/session.guard";
import { ConsumptionService } from "../consumption/consumption.service";
import {
  consumptionExportRequest,
  consumptionExportTrace,
  type DownloadReply,
  sendConsumptionFile,
} from "../consumption/consumption-http";
import { ResellerGuard } from "./reseller.guard";

/**
 * Consommation du parc d'un revendeur, à télécharger (PLAN §10.3).
 *
 * Mêmes gardes que le reste de l'espace revendeur. Le périmètre est le
 * revendeur **inscrit sur chaque journée** : un serveur repris par la
 * plateforme reste facturable par lui pour les jours où il l'hébergeait, et
 * ne l'est plus pour les suivants.
 */
@Controller("api/v1/reseller")
@UseGuards(SessionGuard, ResellerGuard, StaffTwoFactorGuard, ImpersonationReadOnlyGuard)
export class ResellerConsumptionController {
  constructor(
    @Inject(ConsumptionService) private readonly consumption: ConsumptionService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  /** Consigné avant l'envoi, comme l'export de l'administration : le fichier nomme ses clients. */
  @Get("consumption/export")
  async export(
    @Req() request: AuthenticatedRequest & { ip?: string },
    @Query() query: Record<string, unknown>,
    @Res() reply: DownloadReply,
  ): Promise<void> {
    const demand = consumptionExportRequest(query);
    await this.activity.recordRequired(
      consumptionExportTrace("reseller.consumption_exported", request, demand),
    );
    const { period, format, serverId, ownerId } = demand;
    sendConsumptionFile(
      reply,
      this.consumption.exportFile(
        { period, serverId, ownerId, scope: { resellerId: request.user.id } },
        format,
        CONSUMPTION_COLUMNS,
      ),
    );
  }
}
