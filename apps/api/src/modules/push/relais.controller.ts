import {
  PUSH_RELAY_SIGNATURE_HEADER,
  pushRelayHandleSchema,
  pushRelayRegisterSchema,
  pushRelaySendSchema,
} from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { pushConfig } from "./push-config";
import { RelaisService } from "./relais.service";

/**
 * Le relais de notifications de l'éditeur, servi par l'instance qui porte
 * `PUSH_RELAY=1` (ADR 0010) ; 404 partout ailleurs.
 *
 * Trois routes publiques, sans session : un panel s'y enregistre (prouvé par
 * son descripteur), l'application y inscrit son jeton Expo, et un panel y
 * envoie (signé). Les refus restent brefs : ils ne disent rien des poignées.
 */
@Controller("api/v1/relais")
export class RelaisController {
  constructor(@Inject(RelaisService) private readonly relais: RelaisService) {}

  @Post("instances")
  @HttpCode(200)
  async instances(@Body() body: unknown): Promise<{ data: { enregistree: true } }> {
    this.actif();
    const lu = pushRelayRegisterSchema.safeParse(body);
    if (!lu.success) throw new BadRequestException("Enregistrement invalide.");
    if ((await this.relais.enregistrer(lu.data)) !== "enregistree") {
      throw new ForbiddenException(
        "Le descripteur de ce panel ne publie pas cette clé à cette origine.",
      );
    }
    return { data: { enregistree: true } };
  }

  @Post("poignees")
  @HttpCode(200)
  async poignees(@Body() body: unknown): Promise<{ data: { poignee: string } }> {
    this.actif();
    const lu = pushRelayHandleSchema.safeParse(body);
    if (!lu.success) throw new BadRequestException("Inscription invalide.");
    const poignee = await this.relais.inscrire(lu.data);
    if (!poignee) throw new NotFoundException("Ce panel n'est pas servi par ce relais.");
    return { data: { poignee } };
  }

  @Post("envois")
  @HttpCode(200)
  async envois(
    @Body() body: unknown,
    @Headers(PUSH_RELAY_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<{ data: string[] }> {
    const config = this.actif();
    const lu = pushRelaySendSchema.safeParse(body);
    if (!lu.success) throw new BadRequestException("Envoi invalide.");
    if (!signature) throw new UnauthorizedException("Envoi non signé.");
    const issue = await this.relais.envoyer(lu.data, signature, config.expoAccessToken);
    switch (issue.issue) {
      case "envoye":
        return { data: issue.resultats };
      case "inconnue":
        throw new NotFoundException("Instance inconnue de ce relais.");
      case "signature":
      case "perime":
      case "rejoue":
        throw new UnauthorizedException("Signature refusée.");
      case "coupee":
        throw new ForbiddenException("Cette instance est coupée du relais.");
      case "debit":
        throw new HttpException("Trop d'envois cette heure-ci.", 429);
      case "indisponible":
        throw new ServiceUnavailableException("Relais sans accès à Expo.");
    }
  }

  private actif() {
    const config = pushConfig();
    if (!config.relay) throw new NotFoundException();
    return config;
  }
}
