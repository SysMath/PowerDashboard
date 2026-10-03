import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ImpersonationReadOnlyGuard } from "../auth/impersonation.guard";
import { attemptOrigin, PasswordConfirmationService } from "../auth/password-confirmation.service";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { isBrowserSession, SessionGuard } from "../auth/session.guard";
import { AccountPreferencesService } from "./account-preferences.service";
import { ApiKeysService } from "./api-keys.service";

/**
 * Routes du compte de l'utilisateur, hors serveur.
 *
 * Toutes exigent une **session** : une clé d'API ne peut pas en créer d'autres,
 * ni se révoquer elle-même. Sans cette restriction, une clé volée servirait à
 * s'en fabriquer une de portée plus large, et le vol deviendrait permanent.
 */
@Controller("api/v1/client/account")
@UseGuards(SessionGuard, ImpersonationReadOnlyGuard)
export class AccountController {
  constructor(
    @Inject(ApiKeysService) private readonly keys: ApiKeysService,
    @Inject(AccountPreferencesService)
    private readonly preferences: AccountPreferencesService,
    @Inject(PasswordConfirmationService)
    private readonly confirmation: PasswordConfirmationService,
  ) {}

  /**
   * Langue du compte.
   *
   * Une route à elle seule, et non un champ d'un formulaire de profil : c'est
   * le réglage qu'on change depuis l'en-tête, en un clic, sans rien enregistrer
   * d'autre. Le faire passer par « modifier mon profil » obligerait à renvoyer
   * le nom et l'adresse pour choisir « English ».
   *
   * Ouverte aux clés d'API, contrairement au reste de cet écran : changer sa
   * langue n'élargit aucun accès.
   */
  @Post("locale")
  async setLocale(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const { locale } = (body ?? {}) as { locale?: unknown };
    return { data: await this.preferences.setLocale(request.user.id, locale) };
  }

  @Post("timezone")
  async setTimezone(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const { timezone } = (body ?? {}) as { timezone?: unknown };
    return { data: await this.preferences.setTimezone(request.user.id, timezone) };
  }

  @Get("api-keys")
  async list(@Req() request: AuthenticatedRequest) {
    sessionOnly(request);
    return { data: await this.keys.list(request.user.id) };
  }

  /**
   * Crée une clé.
   *
   * Le secret figure dans cette réponse et **nulle part ailleurs** : seul son
   * condensat est écrit en base.
   *
   * Le mot de passe est redemandé (ASVS 3.7.1), après la validation des champs
   * pour qu'une faute de saisie ne coûte pas une tentative : une clé survit à
   * la session qui l'a créée, et c'était le moyen le plus simple de changer
   * une session volée en accès sans fin. Un compte sans mot de passe local
   * passe, faute de secret à redonner (voir `WithoutLocalPassword`).
   */
  @Post("api-keys")
  async create(
    @Req() request: AccountRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown },
  ) {
    sessionOnly(request);
    const { name, scopes, allowedIps, expiresInDays } = (body ?? {}) as {
      name?: unknown;
      scopes?: unknown;
      allowedIps?: unknown;
      expiresInDays?: unknown;
    };

    if (typeof name !== "string" || name.trim() === "") {
      throw new BadRequestException("Libellé manquant.");
    }
    if (!Array.isArray(scopes)) throw new BadRequestException("Portées manquantes.");
    // Absent ou nul : la durée maximale, un an. Le service borne la valeur fournie.
    if (
      expiresInDays !== undefined &&
      expiresInDays !== null &&
      typeof expiresInDays !== "number"
    ) {
      throw new BadRequestException("Validité invalide.");
    }

    const confirmation = await this.confirmation.confirm(
      request.user.id,
      body,
      attemptOrigin(request),
      "allow",
    );
    if (!confirmation.ok) {
      if (confirmation.retryAfterSeconds !== undefined) {
        reply.header("Retry-After", String(confirmation.retryAfterSeconds));
      }
      throw new HttpException(confirmation.message, confirmation.status);
    }

    return {
      data: await this.keys.create(
        request.user.id,
        name,
        scopes.map(String),
        Array.isArray(allowedIps) ? allowedIps.map(String).filter((ip) => ip !== "") : [],
        expiresInDays ?? null,
      ),
    };
  }

  @Delete("api-keys/:keyId")
  async revoke(@Req() request: AuthenticatedRequest, @Param("keyId") keyId: string) {
    sessionOnly(request);
    await this.keys.revoke(request.user.id, keyId);
    return { data: { revoked: keyId } };
  }
}

/** `AuthenticatedRequest` ne porte ni l'adresse ni les en-têtes : Fastify les pose à part. */
type AccountRequest = AuthenticatedRequest & {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

/**
 * Refuse une requête authentifiée par clé d'API.
 *
 * `scopes` non nul signale une clé. Le message le dit explicitement plutôt que
 * de renvoyer un refus muet : l'auteur d'un script doit comprendre que ce n'est
 * pas une portée qui lui manque, mais que ce chemin lui est fermé par nature.
 */
function sessionOnly(request: AuthenticatedRequest): void {
  if (request.scopes !== null) {
    throw new ForbiddenException(
      "Les clés d'API ne peuvent pas gérer les clés d'API. Connectez-vous au panel.",
    );
  }
  // L'application mobile ne crée ni ne lit jamais de clé personnelle (ADR
  // 0010) : un téléphone volé n'en ferait pas un accès sans fin.
  if (!isBrowserSession(request)) {
    throw new ForbiddenException("Les clés d'API se gèrent dans le panel, depuis un navigateur.");
  }
}
