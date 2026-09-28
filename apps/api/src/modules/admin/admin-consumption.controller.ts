import { CONSUMPTION_COLUMNS } from "@gamedashboard/contracts";
import { Controller, Get, Inject, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ActivityService } from "../activity/activity.service";
import { SessionGuard } from "../auth/session.guard";
import { ConsumptionService } from "../consumption/consumption.service";
import {
  consumptionExportRequest,
  consumptionExportTrace,
  type DownloadReply,
  sendConsumptionFile,
} from "../consumption/consumption-http";
import { AdminGuard } from "./admin.guard";
import type { AdminRequest } from "./admin-input";
import { AdminWriteGuard } from "./admin-write.guard";
import { StaffTwoFactorGuard } from "./staff-2fa.guard";

/**
 * Consommation de toute la plateforme, à télécharger (PLAN §10.3).
 *
 * **Administrateurs seulement**, comme l'export du journal : le fichier nomme
 * chaque client par son adresse et son identifiant chez le facturier. Le
 * support répond à un client sur son serveur ; emporter le parc entier hors
 * du panel se décide plus haut — et se consigne, comme l'export du journal.
 */
@Controller("api/v1/admin/consumption")
@UseGuards(SessionGuard, AdminGuard, StaffTwoFactorGuard, AdminWriteGuard)
export class AdminConsumptionController {
  constructor(
    @Inject(ConsumptionService) private readonly consumption: ConsumptionService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  /**
   * La trace est écrite **avant** la première ligne, et son échec empêche
   * l'envoi : un téléchargement interrompu a tout de même eu lieu, et un
   * export sans trace est ce que l'audit doit rendre impossible.
   */
  @Get("export")
  async export(
    @Req() request: AdminRequest,
    @Query() query: Record<string, unknown>,
    @Res() reply: DownloadReply,
  ): Promise<void> {
    const demand = consumptionExportRequest(query);
    await this.activity.recordRequired(
      consumptionExportTrace("admin.consumption_exported", request, demand),
    );
    const { period, format, serverId, ownerId } = demand;
    sendConsumptionFile(
      reply,
      this.consumption.exportFile({ period, serverId, ownerId }, format, CONSUMPTION_COLUMNS),
    );
  }
}
