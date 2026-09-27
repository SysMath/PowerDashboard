import {
  FEATURE_FLAGS,
  featureFlagDefault,
  isSafeBrandUrl,
  isValidReplyTo,
  normalizeDnsDomain,
  normalizeHex,
  PLATFORM_SETTINGS,
  ROLE_PRESETS_SETTING_KEY,
  RolePresetsInput,
  type RolePresetsView,
  resolveRolePresets,
  SETTING_BY_KEY,
  type SettingKind,
  SSO_DEFAULT_SCOPES,
} from "@gamedashboard/contracts";
import { type Database, featureFlags, settings } from "@gamedashboard/db";
import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { assertPublicDestination, PrivateDestinationError } from "../../common/public-url";
import { decryptRowSecret, encryptRowSecret } from "../../common/row-secrets";

/**
 * Valeur servie à l'écran.
 *
 * Un secret n'a pas de `value` : il ne porte que `isConfigured`. Le type le
 * rend impossible à oublier — il n'existe pas de champ où la valeur pourrait
 * se glisser par mégarde.
 */
export type SettingValue =
  | {
      key: string;
      kind: Exclude<SettingKind, "secret">;
      value: string | number | boolean;
    }
  | { key: string; kind: "secret"; isConfigured: boolean };

/**
 * Configuration de l'authentification unique, telle que le serveur l'emploie.
 *
 * Le secret client en fait partie : cet objet ne sort jamais du serveur.
 */
export interface SsoConfiguration {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

/**
 * Serveur d'envoi, tel que le mailer l'emploie.
 *
 * `username` et `password` sont nuls ensemble ou renseignés ensemble dans le
 * cas courant, mais rien ne l'impose : un relais interne accepte souvent sans
 * authentification.
 */
export interface SmtpConfiguration {
  host: string;
  port: number;
  from: string;
  username: string | null;
  password: string | null;
}

export interface FeatureFlagValue {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
}

@Injectable()
export class PlatformSettingsService {
  private readonly logger = new Logger(PlatformSettingsService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Tous les réglages déclarés, avec leur valeur enregistrée ou son repli.
   *
   * La liste vient du catalogue et non de la base : une clé présente en base
   * mais absente du catalogue est un vestige que personne ne lit, et
   * l'afficher ferait croire qu'elle sert encore.
   */
  async all(): Promise<{ values: SettingValue[]; flags: FeatureFlagValue[] }> {
    const keys = [...SETTING_BY_KEY.keys()];
    const rows = await this.db
      .select({ key: settings.key, value: settings.value, isSecret: settings.isSecret })
      .from(settings)
      .where(inArray(settings.key, keys));

    const stored = new Map(rows.map((row) => [row.key, row]));

    const values = PLATFORM_SETTINGS.flatMap((group) =>
      group.settings.map((descriptor): SettingValue => {
        const row = stored.get(descriptor.key);

        if (descriptor.kind === "secret") {
          // Seule information qui sorte d'un secret : est-il renseigné.
          return { key: descriptor.key, kind: "secret", isConfigured: row !== undefined };
        }

        const raw = row?.value;
        return {
          key: descriptor.key,
          kind: descriptor.kind,
          value: coerce(raw, descriptor.kind, descriptor.fallback),
        };
      }),
    );

    return { values, flags: await this.flags() };
  }

  /**
   * Configuration de l'authentification unique, secret compris.
   *
   * C'est la **seule** lecture qui déchiffre un secret, et elle n'est jamais
   * exposée par une route : elle sert à l'échange de jeton, côté serveur.
   * `all()` continue de ne rendre qu'un booléen « configuré ou non », et cette
   * méthode ne doit jamais l'alimenter.
   *
   * Rend `null` dès qu'un réglage indispensable manque, plutôt qu'un objet à
   * trous : une configuration incomplète ne doit pas produire une redirection
   * vers `undefined/authorize`, qui laisserait quelqu'un devant une page
   * d'erreur du fournisseur sans rien comprendre.
   */
  async ssoConfiguration(): Promise<SsoConfiguration | null> {
    const keys = [...SETTING_BY_KEY.keys()].filter((key) => key.startsWith("sso."));
    const rows = await this.db
      .select({ key: settings.key, value: settings.value, isSecret: settings.isSecret })
      .from(settings)
      .where(inArray(settings.key, keys));

    const stored = new Map(rows.map((row) => [row.key, row]));
    const text = (key: string): string => {
      const descriptor = SETTING_BY_KEY.get(key);
      const raw = stored.get(key)?.value ?? descriptor?.fallback ?? "";
      return typeof raw === "string" ? raw.trim() : String(raw);
    };

    const enabled = stored.get("sso.enabled")?.value === true;
    const authorizeUrl = text("sso.authorizeUrl");
    const tokenUrl = text("sso.tokenUrl");
    const userinfoUrl = text("sso.userinfoUrl");
    const clientId = text("sso.clientId");

    const encrypted = stored.get("sso.clientSecret")?.value;
    if (!enabled || !authorizeUrl || !tokenUrl || !userinfoUrl || !clientId) return null;
    if (typeof encrypted !== "string" || encrypted === "") return null;

    let clientSecret: string;
    try {
      clientSecret = decryptRowSecret("settings.value", "sso.clientSecret", encrypted);
    } catch {
      // Secret illisible — clé maître changée, ligne abîmée. Se taire vaut
      // mieux qu'une redirection qui échouera côté fournisseur : l'écran
      // d'administration dira que rien n'est actif.
      this.logger.error("Secret client SSO illisible : l'authentification unique reste inactive.");
      return null;
    }

    return {
      label: text("sso.label") || "Compte externe",
      authorizeUrl,
      tokenUrl,
      userinfoUrl,
      clientId,
      clientSecret,
      scopes: text("sso.scopes") || SSO_DEFAULT_SCOPES,
    };
  }

  /**
   * Client OAuth du bouton « Se connecter avec Google », secret compris.
   *
   * Même règle que `ssoConfiguration` : lu côté serveur seulement, et `null`
   * dès qu'il manque quelque chose — un bouton qui mènerait à une page
   * d'erreur de Google ne doit pas s'afficher.
   */
  async googleConfiguration(): Promise<{ clientId: string; clientSecret: string } | null> {
    if (!(await this.boolean("google.enabled"))) return null;
    const clientId = await this.text("google.clientId");
    const clientSecret = await this.secret("google.clientSecret");
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }

  /**
   * Configuration SMTP, mot de passe compris.
   *
   * Comme pour l'authentification unique : c'est une lecture qui **déchiffre**,
   * elle ne passe par aucune route, et `all()` continue de ne rendre qu'un
   * booléen « configuré ou non ».
   *
   * Rend `null` dès qu'un réglage indispensable manque, plutôt qu'un objet à
   * trous. Un hôte vide donnerait une tentative de connexion vers `undefined`,
   * dont le message d'erreur ne dirait pas que c'est le réglage qui manque.
   * L'authentification, elle, est facultative : un relais interne accepte
   * souvent sans identifiants, et exiger un utilisateur interdirait ce cas
   * parfaitement légitime.
   */
  async smtpConfiguration(): Promise<SmtpConfiguration | null> {
    const keys = [...SETTING_BY_KEY.keys()].filter((key) => key.startsWith("smtp."));
    const rows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, keys));

    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const text = (key: string): string => {
      const raw = stored.get(key) ?? SETTING_BY_KEY.get(key)?.fallback ?? "";
      return typeof raw === "string" ? raw.trim() : String(raw);
    };

    const host = text("smtp.host");
    const from = text("smtp.from");
    const port = Number(
      stored.get("smtp.port") ?? SETTING_BY_KEY.get("smtp.port")?.fallback ?? 587,
    );
    if (!host || !from || !Number.isFinite(port)) return null;

    const encrypted = stored.get("smtp.password");
    let password: string | null = null;
    if (typeof encrypted === "string" && encrypted !== "") {
      try {
        password = decryptRowSecret("settings.value", "smtp.password", encrypted);
      } catch {
        // Mot de passe illisible — clé maître changée, ligne abîmée. Se taire
        // et ne rien envoyer vaut mieux qu'une tentative qui échouera à
        // l'authentification sans que l'écran d'administration le dise.
        this.logger.error("Mot de passe SMTP illisible : aucun courrier ne sera envoyé.");
        return null;
      }
    }

    return { host, port, from, username: text("smtp.username") || null, password };
  }

  /**
   * Valeur d'un réglage booléen, repli du catalogue compris.
   *
   * Sert aux endroits qui ont besoin d'**un** réglage et non de la page
   * entière — la création d'un serveur, par exemple. Passer par `all()` y
   * ferait lire soixante lignes et déchiffrer des secrets pour un seul
   * booléen.
   *
   * Une clé absente du catalogue est refusée plutôt que rendue `false` : un
   * appelant qui se trompe de clé obtiendrait sinon silencieusement le
   * comportement « désactivé », et chercherait longtemps pourquoi son réglage
   * ne s'applique pas.
   */
  async boolean(key: string): Promise<boolean> {
    const descriptor = SETTING_BY_KEY.get(key);
    if (descriptor?.kind !== "boolean") {
      throw new BadRequestException(`Réglage booléen inconnu : « ${key} ».`);
    }

    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);

    return coerce(row?.value, "boolean", descriptor.fallback) === true;
  }

  /**
   * Valeur d'un réglage textuel, repli du catalogue compris.
   *
   * Pendant de `boolean()`, et pour la même raison : composer un courrier a
   * besoin du nom de la plateforme et de son domaine, pas de la page entière
   * ni de ses secrets déchiffrés.
   *
   * Un secret est **refusé** ici : ils ne sortent que par les lectures qui les
   * déchiffrent explicitement, et une méthode générique qui accepterait de les
   * rendre finirait par en rendre un.
   */
  async text(key: string): Promise<string> {
    const descriptor = SETTING_BY_KEY.get(key);
    if (!descriptor || descriptor.kind === "secret") {
      throw new BadRequestException(`Réglage textuel inconnu : « ${key} ».`);
    }

    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);

    const raw = row?.value ?? descriptor.fallback ?? "";
    return typeof raw === "string" ? raw.trim() : String(raw);
  }

  /**
   * Valeur déchiffrée d'un secret.
   *
   * Contrairement à `text()`, qui les refuse. La distinction est la règle de ce
   * service : un secret ne sort que par une méthode dont le nom dit ce qu'elle
   * fait, jamais par un accesseur générique dans lequel il pourrait se glisser
   * sans que l'appelant s'en rende compte.
   *
   * Rend une chaîne vide plutôt que de lever quand le secret est illisible —
   * clé maître changée, ligne abîmée. L'appelant traite alors ce cas comme
   * « non configuré », ce qui est la lecture prudente : mieux vaut un stockage
   * distant inactif qu'un dépôt tenté avec des identifiants faux.
   */
  async secret(key: string): Promise<string> {
    const descriptor = SETTING_BY_KEY.get(key);
    if (descriptor?.kind !== "secret") {
      throw new BadRequestException(`Secret inconnu : « ${key} ».`);
    }

    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);

    if (typeof row?.value !== "string" || row.value === "") return "";

    try {
      return decryptRowSecret("settings.value", key, row.value);
    } catch {
      this.logger.error(`Secret « ${key} » illisible : traité comme non renseigné.`);
      return "";
    }
  }

  /**
   * Un drapeau est-il levé ?
   *
   * Employé par les gardes, là où `flags()` sert l'écran. Les deux partagent le
   * même défaut, sans quoi l'interrupteur affiché et la porte réelle finiraient
   * par se contredire — ce qui est exactement ce qui se passait quand ces
   * drapeaux ne commandaient rien.
   */
  async flag(key: string): Promise<boolean> {
    const [row] = await this.db
      .select({ enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(eq(featureFlags.key, key))
      .limit(1);

    return row?.enabled ?? featureFlagDefault(key);
  }

  /** Drapeaux déclarés, avec leur état réel. Un drapeau inconnu est ignoré. */
  async flags(): Promise<FeatureFlagValue[]> {
    const rows = await this.db
      .select({ key: featureFlags.key, enabled: featureFlags.enabled })
      .from(featureFlags);
    const stored = new Map(rows.map((row) => [row.key, row.enabled]));

    return FEATURE_FLAGS.map((flag) => ({
      ...flag,
      enabled: stored.get(flag.key) ?? flag.default,
    }));
  }

  /**
   * Enregistre un lot de réglages.
   *
   * Deux règles, et les deux tiennent la table exploitable :
   *
   * 1. une clé absente du catalogue est **refusée**. La table accepterait
   *    n'importe quoi, et une faute de frappe produirait un réglage écrit,
   *    jamais lu, et impossible à distinguer d'un réglage qui ne marche pas.
   * 2. un secret reçu vide signifie « ne change rien ». Sans cette règle, le
   *    formulaire — dont le champ mot de passe est toujours vide, puisqu'on ne
   *    le relit jamais — effacerait la configuration SMTP à chaque
   *    enregistrement de la couleur d'accent.
   */
  async save(
    values: Record<string, unknown>,
    // Une transaction en cours, quand l'écriture doit en faire partie (envoi
    // d'une image de marque, `BrandImagesService`).
    db: Pick<Database, "insert"> = this.db,
  ): Promise<{ saved: string[] }> {
    const saved: string[] = [];

    for (const [key, raw] of Object.entries(values)) {
      const descriptor = SETTING_BY_KEY.get(key);
      if (!descriptor) throw new BadRequestException(`Réglage inconnu : « ${key} ».`);

      if (descriptor.kind === "secret") {
        if (typeof raw !== "string" || raw === "") continue;
        if (descriptor.format === "token" && !/^[A-Za-z0-9_-]{20,255}$/.test(raw.trim())) {
          throw new BadRequestException(
            `« ${descriptor.label} » doit être un jeton d'un seul tenant : lettres, chiffres, « _ » et « - ».`,
          );
        }
        // La clé du réglage tient lieu d'identifiant de ligne : c'est elle
        // que la table rend unique, et elle ne change jamais.
        const secret = descriptor.format === "token" ? raw.trim() : raw;
        await upsert(db, key, encryptRowSecret("settings.value", key, secret), true);
        saved.push(key);
        continue;
      }

      /**
       * Un nombre inexploitable est **refusé**, et non ramené au repli.
       *
       * `coerce` retombe sur la valeur par défaut, ce qui convient à la lecture
       * — une base vide doit servir quelque chose. À l'écriture, ce serait
       * enregistrer 587 quand quelqu'un a tapé « deux mille », sans rien dire.
       */
      if (descriptor.kind === "number" && !Number.isFinite(Number(raw))) {
        throw new BadRequestException(`Valeur numérique attendue pour « ${key} ».`);
      }

      /**
       * Un choix hors de la liste est **refusé**, pas ramené au repli.
       *
       * « Quel système de facturation » décide du comportement du panel : une
       * valeur inconnue enregistrée sans bruit produirait une plateforme qui se
       * croit configurée et n'ouvre en réalité aucun chemin d'entrée à ses
       * clients. Le refus nomme les valeurs admises, puisqu'il n'y a rien de
       * secret dans une liste que l'écran affiche déjà.
       */
      if (descriptor.kind === "choice") {
        const admises = descriptor.choices?.map((c) => c.value) ?? [];
        if (!admises.includes(String(raw))) {
          throw new BadRequestException(
            `Valeur refusée pour « ${key} ». Attendu : ${admises.join(", ")}.`,
          );
        }
      }

      /*
       * La forme des réglages de marque, contrôlée comme pour un revendeur.
       *
       * Ces valeurs finissent dans un `src`, un `href` ou une variable CSS de
       * chaque page, domaines des revendeurs compris quand ils n'ont rien
       * surchargé. Le contrôle est celui de `BrandingService.save`, par la
       * même fonction : la plateforme n'a pas à être moins protégée qu'un
       * revendeur.
       */
      let text = typeof raw === "string" ? raw.trim() : String(raw ?? "");
      if (descriptor.format === "url" && !isSafeBrandUrl(text)) {
        throw new BadRequestException(
          `« ${descriptor.label} » doit commencer par « https:// » ou par « / » (chemin interne).`,
        );
      }
      if (descriptor.format === "hex" && text !== "" && normalizeHex(text) === null) {
        throw new BadRequestException(
          `« ${descriptor.label} » doit être une couleur hexadécimale, comme #0ea5e9.`,
        );
      }
      if (descriptor.format === "email" && !isValidReplyTo(text)) {
        throw new BadRequestException(
          `« ${descriptor.label} » doit être une seule adresse e-mail, comme support@exemple.fr.`,
        );
      }
      if (descriptor.format === "domain" && text !== "") {
        const domain = normalizeDnsDomain(text);
        if (domain === null) {
          throw new BadRequestException(
            `« ${descriptor.label} » doit être un nom de domaine, comme jeux.exemple.fr.`,
          );
        }
        text = domain;
      }
      if (descriptor.format === "outbound" && text !== "") {
        await assertOutboundSetting(text, descriptor.label);
      }

      await upsert(
        db,
        key,
        coerce(descriptor.format ? text : raw, descriptor.kind, descriptor.fallback),
        false,
      );
      saved.push(key);
    }

    return { saved };
  }

  async setFlag(key: string, enabled: boolean): Promise<void> {
    if (!FEATURE_FLAGS.some((flag) => flag.key === key)) {
      throw new BadRequestException(`Fonctionnalité inconnue : « ${key} ».`);
    }

    await this.db
      .insert(featureFlags)
      .values({ key, enabled })
      .onConflictDoUpdate({
        target: featureFlags.key,
        set: { enabled, updatedAt: new Date().toISOString() },
      });
  }

  /* --- Presets de sous-utilisateurs (§5.2) -------------------------------- */

  /**
   * Les presets proposés à l'invitation, tels que l'administration les a
   * redéfinis, avec repli sur ceux du code.
   *
   * Rangés dans `settings` sous une clé hors du catalogue des réglages : ce
   * n'est pas un champ de formulaire mais une structure, et `save()` doit
   * continuer de refuser toute clé qu'il ne connaît pas. `all()` ne la montre
   * pas pour la même raison.
   */
  async rolePresets(): Promise<RolePresetsView> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, ROLE_PRESETS_SETTING_KEY))
      .limit(1);

    return resolveRolePresets(row?.value);
  }

  /**
   * Redéfinit les presets.
   *
   * **Ne touche à aucun sous-utilisateur existant**, et c'est voulu : leurs
   * permissions ont été recopiées une à une au moment de l'invitation, et la
   * liste stockée fait foi (`server_subusers.permissions`). Élargir un preset
   * n'élargit donc les droits de personne rétroactivement — ce serait accorder
   * à des gens invités il y a des mois ce que leur propriétaire n'a jamais
   * coché. Seules les invitations à venir partent de la nouvelle définition.
   *
   * Le jeu entier est enregistré d'un bloc, validé avant d'écrire : un preset
   * refusé n'en laisse pas deux autres à moitié enregistrés.
   */
  async saveRolePresets(input: unknown): Promise<RolePresetsView> {
    const parsed = RolePresetsInput.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? "Presets invalides.");
    }

    await upsert(this.db, ROLE_PRESETS_SETTING_KEY, parsed.data, false);
    return resolveRolePresets(parsed.data);
  }

  /**
   * Rétablit les presets du code.
   *
   * La ligne est supprimée plutôt que réécrite avec les valeurs actuelles du
   * code : une installation « aux valeurs par défaut » doit suivre les
   * défauts des versions suivantes, pas rester figée sur ceux du jour du clic.
   */
  async resetRolePresets(): Promise<RolePresetsView> {
    await this.db.delete(settings).where(eq(settings.key, ROLE_PRESETS_SETTING_KEY));
    return resolveRolePresets(undefined);
  }
}

async function upsert(
  db: Pick<Database, "insert">,
  key: string,
  value: unknown,
  isSecret: boolean,
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value, isSecret })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, isSecret, updatedAt: new Date().toISOString() },
    });
}

/**
 * Une adresse que le panel appellera lui-même : `https://`, et publique.
 *
 * Contrôlée à l'enregistrement pour que l'administrateur l'apprenne tout de
 * suite ; le service qui appelle la juge encore à chaque lecture, puisque le
 * nom peut résoudre ailleurs ensuite (rapport ASVS, NC-56).
 */
async function assertOutboundSetting(value: string, label: string): Promise<void> {
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (url?.protocol !== "https:") {
    throw new BadRequestException(`« ${label} » doit commencer par « https:// ».`);
  }

  try {
    await assertPublicDestination(url);
  } catch (error) {
    if (error instanceof PrivateDestinationError) {
      throw new BadRequestException(
        `« ${label} » : ${error.message} Le panel appellerait lui-même cette adresse.`,
      );
    }
    throw error;
  }
}

/**
 * Ramène une valeur au type déclaré.
 *
 * `settings.value` est du `jsonb` : la base accepte une chaîne là où on attend
 * un nombre, et une valeur mal typée ne se découvre qu'au moment de s'en
 * servir — c'est-à-dire en production, à l'envoi d'un e-mail.
 */
function coerce(
  raw: unknown,
  kind: Exclude<SettingKind, "secret">,
  fallback: string | number | boolean | undefined,
): string | number | boolean {
  if (raw === undefined || raw === null) return fallback ?? defaultFor(kind);

  if (kind === "boolean") return raw === true || raw === "true";
  if (kind === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : (fallback ?? 0);
  }
  return String(raw);
}

function defaultFor(kind: Exclude<SettingKind, "secret">): string | number | boolean {
  if (kind === "boolean") return false;
  if (kind === "number") return 0;
  return "";
}
