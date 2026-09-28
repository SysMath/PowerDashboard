import type { Branding } from "@gamedashboard/contracts";
import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { singleQuery } from "../../common/query-param";
import { BrandImagesService, type StoredBrandImage } from "./brand-images.service";
import { BrandingService } from "./branding.service";

/** Ce que la route d'image emploie de la réponse Fastify. */
interface ImageReply {
  status(code: number): ImageReply;
  header(name: string, value: string): ImageReply;
  send(payload?: unknown): unknown;
}

/**
 * Résolution de la marque, sans session.
 *
 * **Publique et sans authentification**, parce qu'elle sert la page de
 * connexion : la marque doit être en place avant que quiconque se connecte,
 * sinon un client d'un revendeur verrait la marque de la plateforme le temps de
 * saisir son mot de passe — précisément l'écran qui doit le rassurer.
 *
 * Elle ne révèle que ce qui est déjà affiché à qui ouvre l'adresse : un nom, un
 * logo, une couleur.
 *
 * **Un seul vhost sert tous les domaines.** Le panel ne demande pas un serveur
 * web par revendeur : l'hôte de la requête voyage jusqu'ici et décide de la
 * marque. C'est ce qui permet d'ajouter un domaine sans toucher à la
 * configuration du serveur — le revendeur publie son CNAME, vérifie, et son
 * domaine est servi à la requête suivante.
 */
@Controller("api/v1/branding")
export class BrandingController {
  constructor(
    @Inject(BrandingService) private readonly branding: BrandingService,
    @Inject(BrandImagesService) private readonly images: BrandImagesService,
  ) {}

  /**
   * L'hôte est **transmis explicitement** par la couche web.
   *
   * L'API ne voit pas l'hôte du navigateur : c'est Next qui l'appelle, et elle
   * lirait son propre `Host`. Le paramètre est donc la seule source possible.
   *
   * Rien ici n'est une décision de sécurité : un hôte falsifié ne donne que la
   * marque d'un revendeur — un logo et une couleur — jamais un accès. Les
   * routes qui décident de quelque chose lisent la session, jamais cet en-tête.
   */
  @Get()
  async resolve(
    @Query("host") host?: unknown,
    @Headers("x-gd-host") forwarded?: string,
  ): Promise<{ data: Branding }> {
    return { data: await this.branding.forHost(singleQuery(host, "host") ?? forwarded ?? null) };
  }

  /**
   * Logo ou favicon envoyé par fichier, servi à l'interface (`/brand/fichier/<id>`).
   *
   * Publique pour la même raison que la marque : la page de connexion
   * l'affiche. L'identifiant est un UUID tiré au hasard, et l'image est de
   * toute façon montrée à quiconque ouvre le domaine.
   */
  @Get("images/:id")
  async image(
    @Param("id") id: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res() reply: ImageReply,
  ): Promise<void> {
    const image = await this.images.read(id);
    if (image === null) throw new NotFoundException("Image introuvable.");
    sendBrandImage(reply, image, ifNoneMatch);
  }
}

/**
 * En-têtes d'une image de marque, et réponse `304` quand le navigateur l'a déjà.
 *
 * - `Content-Type` : celui **lu dans les octets** à l'envoi, jamais un autre.
 * - `nosniff` (posé aussi par `registerResponseHeaders`) : le navigateur s'en
 *   tient à ce type.
 * - `Content-Security-Policy: default-src 'none'; sandbox` : si l'image était
 *   ouverte comme un document, rien n'y serait chargé ni exécuté.
 * - Cache sans limite (`immutable`) : une adresse ne change jamais de contenu,
 *   un nouvel envoi en crée une autre. L'ETag est l'empreinte SHA-256.
 */
export function sendBrandImage(
  reply: ImageReply,
  image: StoredBrandImage,
  ifNoneMatch: string | undefined,
): void {
  const etag = `"${image.sha256}"`;
  reply
    .header("content-type", image.contentType)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("cache-control", "public, max-age=31536000, immutable")
    .header("etag", etag);

  const connus = (ifNoneMatch ?? "").split(",").map((valeur) => valeur.trim());
  if (connus.includes(etag) || connus.includes(`W/${etag}`)) {
    reply.status(304).send();
    return;
  }
  reply.status(200).send(image.bytes);
}
