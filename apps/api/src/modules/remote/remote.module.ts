import { Module } from "@nestjs/common";
import { databaseProvider } from "../../common/database.provider";
import { ActivityModule } from "../activity/activity.module";
import { AdminModule } from "../admin/admin.module";
import { SshKeyRepository } from "../auth/ssh-key.repository";
import { NotificationsModule } from "../notifications/notifications.module";
import { StorageModule } from "../storage/storage.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { NodeRepository } from "./node.repository";
import { NodeTokenGuard } from "./node-token.guard";
import { RemoteController } from "./remote.controller";
import { RemoteActivityService } from "./remote-activity.service";
import { RemoteBackupService } from "./remote-backup.service";
import { RemoteServerService } from "./remote-server.service";
import { RestoreReaperService } from "./restore-reaper.service";
import { SftpAuthService } from "./sftp-auth.service";

/**
 * Module isolé des routes appelées par Wings.
 *
 * Il ne partage rien avec les modules client et application : ni garde, ni
 * intergiciel de session, ni format d'erreur. Cette séparation n'est pas une
 * précaution de style — un intergiciel d'authentification appliqué par erreur
 * ici renverrait une redirection vers /login, que le daemon traite comme une
 * panne du panel, et tous les nodes paraîtraient tombés.
 */
@Module({
  // `StorageModule` pour le dépôt distant des sauvegardes : le daemon ne peut
  // ni ouvrir ni clore un dépôt fractionné, faute de nos identifiants.
  // `ActivityModule` pour le journal des refus : un jeton de node refusé s'y
  // consigne.
  imports: [NotificationsModule, WebhooksModule, AdminModule, StorageModule, ActivityModule],
  controllers: [RemoteController],
  providers: [
    databaseProvider,
    NodeRepository,
    RemoteServerService,
    RemoteBackupService,
    RestoreReaperService,
    RemoteActivityService,
    SftpAuthService,
    // Le dépôt de clés vient du module d'authentification par nature ; il est
    // fourni ici plutôt qu'importé, parce que ce module ne partage volontairement
    // aucune garde ni aucun intergiciel avec celui-là.
    SshKeyRepository,
    NodeTokenGuard,
  ],
})
export class RemoteModule {}
