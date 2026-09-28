import { Module } from "@nestjs/common";
import { databaseProvider } from "../../common/database.provider";
import { ConsumptionService } from "./consumption.service";
import { ConsumptionRollupService } from "./consumption-rollup.service";

/**
 * La consommation exportable des serveurs (PLAN §10.3).
 *
 * Module à part, comme les sous-domaines : l'administration, l'espace
 * revendeur, la page d'un serveur et l'API applicative la lisent tous, chacun
 * avec son périmètre. Le résumé journalier vit ici aussi, pour qu'une seule
 * instance du minuteur existe quel que soit le nombre de modules qui
 * l'importent.
 */
@Module({
  providers: [databaseProvider, ConsumptionService, ConsumptionRollupService],
  exports: [ConsumptionService],
})
export class ConsumptionModule {}
