import { DEFAULT_METRICS_RANGE, MetricsHistory, MetricsRange } from "@gamedashboard/contracts";
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ImpersonationReadOnlyGuard } from "../auth/impersonation.guard";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { SessionGuard } from "../auth/session.guard";
import { accessPrincipal, ServerAccessService } from "./server-access.service";
import { ServerMetricsService } from "./server-metrics.service";

/**
 * Historique des mesures d'un serveur.
 *
 * Un contrôleur à part plutôt qu'une route de plus sur celui d'exécution : ce
 * dernier ne fait que relayer ce que seul le daemon connaît, alors que
 * l'historique est un registre tenu par le panel. Les mêler laisserait croire
 * qu'une panne de Wings rend l'historique illisible — c'est l'inverse, il
 * reste lisible précisément quand le daemon se tait.
 */
@Controller("api/v1/client/servers/:id")
@UseGuards(SessionGuard, ImpersonationReadOnlyGuard)
export class ServerMetricsController {
  constructor(
    @Inject(ServerAccessService) private readonly access: ServerAccessService,
    @Inject(ServerMetricsService) private readonly metrics: ServerMetricsService,
  ) {}

  /**
   * Série agrégée sur une plage : `1h`, `24h`, `7d` ou `30d`.
   *
   * Même permission que la consommation instantanée, `console.read` : ce sont
   * les mêmes chiffres, étalés dans le temps. Exiger davantage empêcherait de
   * lire hier ce qu'on a le droit de voir aujourd'hui ; exiger moins ouvrirait
   * la consommation à qui n'a pas accès à la console.
   *
   * Une plage inconnue est **refusée**, pas remplacée : un script qui demande
   * `90d` doit apprendre que cette plage n'existe pas, et non recevoir trente
   * jours en croyant en lire quatre-vingt-dix.
   */
  @Get("metrics")
  async history(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("range") range?: string,
  ) {
    const parsed = MetricsRange.safeParse(range ?? DEFAULT_METRICS_RANGE);
    if (!parsed.success) {
      throw new BadRequestException(
        `Plage inconnue : utilisez ${MetricsRange.options.map((r) => `« ${r} »`).join(", ")}.`,
      );
    }

    await this.access.require(accessPrincipal(request), id, "console.read");

    // La réponse repasse par son schéma : c'est le contrat promis à l'écran et
    // au SDK, et une colonne rendue en chaîne par le pilote doit casser ici,
    // pas dans un graphe.
    return { data: MetricsHistory.parse(await this.metrics.history(id, parsed.data)) };
  }
}
