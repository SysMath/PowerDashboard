import { Module } from "@nestjs/common";
import { databaseProvider } from "../../common/database.provider";
import { ActivityModule } from "../activity/activity.module";
import { AdminModule } from "../admin/admin.module";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { AuthModule } from "../auth/auth.module";
import { AdminNodeAgentController } from "./admin-node-agent.controller";
import { NodeAgentController } from "./node-agent.controller";
import { NodeAgentRepository } from "./node-agent.repository";
import { NodeAgentTokenGuard } from "./node-agent-token.guard";
import { NodeCapabilitiesService } from "./node-capabilities.service";

/**
 * Agent de node (ADR 0008, ADR 0009) : le socle que chaque fonction partage.
 *
 * Comme le module `remote`, les routes de machine ne partagent aucune garde
 * de session ; la fiche d'administration, elle, a les gardes ordinaires de
 * l'administration. `NodeCapabilitiesService` sort pour les modules des
 * fonctions : c'est par lui qu'une route vérifie ce que le node offre.
 */
@Module({
  imports: [AuthModule, AdminModule, ActivityModule],
  controllers: [NodeAgentController, AdminNodeAgentController],
  providers: [
    databaseProvider,
    NodeAgentRepository,
    NodeAgentTokenGuard,
    NodeCapabilitiesService,
    PlatformSettingsService,
  ],
  // La garde sort pour les routes de machine des fonctions (instantanés…).
  exports: [NodeAgentRepository, NodeAgentTokenGuard, NodeCapabilitiesService],
})
export class NodeAgentModule {}
