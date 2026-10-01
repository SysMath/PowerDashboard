import { Module } from "@nestjs/common";
import { databaseProvider } from "../../common/database.provider";
import { ActivityModule } from "../activity/activity.module";
import { AdminModule } from "../admin/admin.module";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { AuthModule } from "../auth/auth.module";
import { ClientModule } from "../client/client.module";
import { NodeAgentModule } from "../node-agent/node-agent.module";
import { WingsModule } from "../wings/wings.module";
import { AdminSnapshotsController } from "./admin-snapshots.controller";
import { AgentSnapshotsController } from "./agent-snapshots.controller";
import { ClientSnapshotsController } from "./client-snapshots.controller";
import { SnapshotHooks } from "./snapshot-hooks";
import { SnapshotPolicyService } from "./snapshot-policy.service";
import { SnapshotsService } from "./snapshots.service";

/**
 * Instantanés de volumes (ADR 0009) : la première fonction de l'agent de
 * node. Ses routes de machine, de client et d'administration vivent ici,
 * chacune derrière la garde de son espace.
 */
@Module({
  imports: [AuthModule, AdminModule, ActivityModule, ClientModule, NodeAgentModule, WingsModule],
  controllers: [AgentSnapshotsController, ClientSnapshotsController, AdminSnapshotsController],
  // La garde du second facteur du personnel lit les réglages de la plateforme.
  providers: [
    databaseProvider,
    PlatformSettingsService,
    SnapshotPolicyService,
    SnapshotsService,
    SnapshotHooks,
  ],
  exports: [SnapshotsService, SnapshotPolicyService],
})
export class SnapshotsModule {}
