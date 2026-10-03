import { Module } from "@nestjs/common";
import { databaseProvider } from "../../common/database.provider";
import { PushSenderService } from "./push-sender.service";
import { RelaisController } from "./relais.controller";
import { RelaisService } from "./relais.service";

/**
 * Notifications poussées vers l'application mobile (ADR 0010) : l'envoi de
 * la file, et le relais de l'éditeur quand ce panel le porte. La mise en
 * file (`PushOutboxService`) est fournie par le module des notifications,
 * qui l'appelle ; l'envoi n'existe qu'ici, une seule fois par processus.
 */
@Module({
  controllers: [RelaisController],
  providers: [databaseProvider, PushSenderService, RelaisService],
})
export class PushModule {}
