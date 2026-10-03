import {
  type AppDeviceGrant,
  type AppDeviceSummary,
  appAuthorizeBodySchema,
  appPushBodySchema,
  appRefreshBodySchema,
  appTokenBodySchema,
} from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ActivityService } from "../activity/activity.service";
import { pushConfig } from "../push/push-config";
import { AppDeviceRepository, type AppGrantOutcome } from "./app-device.repository";
import { BrowserSessionGuard } from "./browser-session.guard";
import { ImpersonationReadOnlyGuard } from "./impersonation.guard";
import { SecurityAlertService } from "./security-alert.service";
import { type AuthenticatedRequest, SessionGuard } from "./session.guard";

type DeviceRequest = Partial<AuthenticatedRequest> & {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
};

/** Refus unique de l'échange : ne dit jamais lequel des contrôles a échoué. */
const REFUSED = "Liaison refusée. Recommencez depuis l'application.";

/**
 * Liaison de l'application mobile (ADR 0010), et ses appareils au compte.
 *
 * - `app/authorize` : la personne, connectée dans le navigateur du téléphone,
 *   accepte ; le panel rend un code de soixante secondes ;
 * - `app/token` et `app/refresh` : **publiques**, elles s'authentifient par
 *   ce qu'elles portent (code et PKCE, ou secret d'appareil), toujours signé
 *   par la clé de l'appareil ;
 * - `app/challenge`, `app/device` et `app/push` : par le jeton de l'appareil ;
 * - `devices` : la liste du compte, dans le navigateur seulement.
 */
@Controller("api/v1/auth")
export class AppDeviceController {
  constructor(
    @Inject(AppDeviceRepository) private readonly devices: AppDeviceRepository,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(SecurityAlertService) private readonly alerts: SecurityAlertService,
  ) {}

  /**
   * Accepte la liaison d'un téléphone, depuis la page du panel qui la demande.
   *
   * Refusée à une session empruntée par le personnel, lecture seule ou non :
   * lier un téléphone au compte d'un client, c'est garder la main chez lui
   * après la fin de la prise en main.
   */
  @Post("app/authorize")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async authorize(@Req() request: DeviceRequest, @Body() body: unknown) {
    const user = request.user;
    if (!user) throw new UnauthorizedException();
    if (user.impersonator) {
      throw new ForbiddenException("Une prise en main ne lie pas d'appareil au compte.");
    }
    const parsed = appAuthorizeBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Demande de liaison invalide.");

    return { data: await this.devices.createLinkCode(user.id, parsed.data) };
  }

  /** Échange le code contre un appareil, son jeton d'accès et son secret. */
  @Post("app/token")
  @HttpCode(200)
  async token(
    @Req() request: DeviceRequest,
    @Body() body: unknown,
  ): Promise<{ data: AppDeviceGrant }> {
    const parsed = appTokenBodySchema.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException(REFUSED);
    const outcome = await this.devices.exchange({ ...parsed.data, ip: request.ip ?? null });
    return { data: await this.settle(outcome, request, "linked") };
  }

  /** Nouveau jeton d'accès, nouveau secret d'appareil : l'ancien ne vaut plus rien. */
  @Post("app/refresh")
  @HttpCode(200)
  async refresh(
    @Req() request: DeviceRequest,
    @Body() body: unknown,
  ): Promise<{ data: AppDeviceGrant }> {
    const parsed = appRefreshBodySchema.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException(REFUSED);
    const outcome = await this.devices.refresh({ ...parsed.data, ip: request.ip ?? null });
    return { data: await this.settle(outcome, request, "refreshed") };
  }

  /** Défi à signer pour confirmer sa présence avant un geste lourd. */
  @Post("app/challenge")
  @UseGuards(SessionGuard)
  async challenge(@Req() request: DeviceRequest) {
    if (!request.appDeviceId) {
      throw new ForbiddenException("Réservé à l'application mobile.");
    }
    return { data: await this.devices.issueChallenge(request.appDeviceId) };
  }

  /** L'application se délie elle-même (« Se déconnecter de ce panel »). */
  @Delete("app/device")
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async unlinkSelf(@Req() request: DeviceRequest): Promise<void> {
    if (!request.user || !request.appDeviceId) {
      throw new ForbiddenException("Réservé à l'application mobile.");
    }
    const name = await this.devices.revokeById(request.user.id, request.appDeviceId, "device");
    if (name) await this.record(request, request.user.id, "account.app_device_revoked", name);
  }

  /**
   * L'application dépose où lui pousser ses notifications : son jeton Expo
   * en mode `direct`, sa poignée du relais en mode `relais`. Seul le mode que
   * sert le panel est accepté ; « aucune » refuse tout dépôt.
   */
  @Put("app/push")
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async push(@Req() request: DeviceRequest, @Body() body: unknown): Promise<void> {
    if (!request.appDeviceId) throw new ForbiddenException("Réservé à l'application mobile.");
    const parsed = appPushBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Inscription aux notifications invalide.");
    if (parsed.data.mode !== pushConfig().mode) {
      throw new ConflictException("Ce panel n'envoie pas ses notifications par ce chemin.");
    }
    await this.devices.setPush(request.appDeviceId, parsed.data);
  }

  /** L'application ne veut plus de notifications sur ce téléphone. */
  @Delete("app/push")
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async unpush(@Req() request: DeviceRequest): Promise<void> {
    if (!request.appDeviceId) throw new ForbiddenException("Réservé à l'application mobile.");
    await this.devices.setPush(request.appDeviceId, null);
  }

  /** Appareils mobiles liés au compte, pour Compte › Sécurité. */
  @Get("devices")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async list(@Req() request: DeviceRequest): Promise<{ data: AppDeviceSummary[] }> {
    if (!request.user) throw new UnauthorizedException();
    return { data: await this.devices.listForUser(request.user.id) };
  }

  /**
   * Retire un appareil. 404 sans distinguer inconnu, à quelqu'un d'autre ou
   * déjà retiré, comme pour une session.
   */
  @Delete("devices/:id")
  @HttpCode(204)
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async revoke(@Req() request: DeviceRequest, @Param("id") id: string): Promise<void> {
    if (!request.user) throw new UnauthorizedException();
    const name = /^[0-9a-f-]{36}$/i.test(id)
      ? await this.devices.revokeById(request.user.id, id, "user")
      : null;
    if (!name) throw new NotFoundException("Appareil introuvable.");
    await this.record(request, request.user.id, "account.app_device_revoked", name);
  }

  /**
   * Rend le jeton, ou refuse. Un rejeu retire l'appareil, se consigne et
   * prévient le titulaire ; une liaison réussie aussi, comme tout nouvel
   * accès durable au compte.
   */
  private async settle(
    outcome: AppGrantOutcome,
    request: DeviceRequest,
    kind: "linked" | "refreshed",
  ): Promise<AppDeviceGrant> {
    if (outcome.status === "replayed") {
      await this.record(request, outcome.userId, "account.app_device_replayed", outcome.deviceName);
      this.alerts.afterCredentialChange({
        userId: outcome.userId,
        kind: "appDeviceReplayed",
        ip: request.ip ?? null,
        host: null,
      });
      throw new UnauthorizedException(REFUSED);
    }
    if (outcome.status !== "granted") throw new UnauthorizedException(REFUSED);

    if (kind === "linked") {
      await this.record(request, outcome.userId, "account.app_device_linked", outcome.deviceName);
      this.alerts.afterCredentialChange({
        userId: outcome.userId,
        kind: "appDeviceLinked",
        ip: request.ip ?? null,
        host: null,
      });
    }
    return outcome.grant;
  }

  private async record(
    request: DeviceRequest,
    userId: string,
    event: string,
    device: string,
  ): Promise<void> {
    const agent = request.headers["user-agent"];
    const label = request.user?.email ?? (await this.devices.accountEmail(userId)) ?? userId;
    await this.activity.record({
      event,
      serverId: null,
      actorId: userId,
      actorType: "user",
      actorLabel: label,
      ip: request.ip ?? null,
      userAgent: (Array.isArray(agent) ? agent[0] : agent) ?? null,
      properties: { device },
    });
  }
}
