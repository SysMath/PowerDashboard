import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminModule } from "./modules/admin/admin.module";
import { ApplicationModule } from "./modules/application/application.module";
import { AuthModule } from "./modules/auth/auth.module";
import { ClientModule } from "./modules/client/client.module";
import { HealthModule } from "./modules/health/health.module";
import { NodeAgentModule } from "./modules/node-agent/node-agent.module";
import { RemoteModule } from "./modules/remote/remote.module";
import { ResellerModule } from "./modules/reseller/reseller.module";
import { SchedulerModule } from "./modules/scheduler/scheduler.module";
import { SnapshotsModule } from "./modules/snapshots/snapshots.module";
import { StatusModule } from "./modules/status/status.module";
import { UpdatesModule } from "./modules/updates/updates.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // En premier : ce module doit répondre même si un autre refuse de
    // s'initialiser, puisque c'est lui qu'on interroge alors.
    HealthModule,
    AuthModule,
    ClientModule,
    AdminModule,
    ResellerModule,
    // API des systèmes tiers : la facturation vit hors de ce projet et pilote
    // le panel par ici, avec ses propres clés et ses propres portées.
    ApplicationModule,
    RemoteModule,
    // Agent de node facultatif (ADR 0008, 0009) : ses routes de machine et
    // sa fiche d'administration.
    NodeAgentModule,
    // Instantanés de volumes, première fonction de l'agent (ADR 0009).
    SnapshotsModule,
    SchedulerModule,
    // Page de statut : lecture publique sans compte, rédaction réservée.
    StatusModule,
    // Mise à jour autonome depuis les releases GitHub (hébergement cPanel) ;
    // inerte ailleurs.
    UpdatesModule,
  ],
})
export class AppModule {}
