import type { NavSection } from "@gamedashboard/ui";
import {
  Activity,
  Archive,
  Calendar,
  ChartColumn,
  Cpu,
  Database,
  Egg,
  FileCode2,
  Files,
  FolderTree,
  Gauge,
  Globe,
  HardDrive,
  History,
  Key,
  Layers,
  LayoutDashboard,
  Megaphone,
  Network,
  Package,
  Palette,
  Plug,
  RadioTower,
  Server,
  Settings,
  Shield,
  Siren,
  Store,
  Terminal,
  User,
  UserRound,
  Users,
  Webhook,
} from "lucide-react";
import { showcaseServed } from "@/lib/design-showcase";

/**
 * Navigation du panel (cf. PLAN.md §2.4).
 *
 * Des fonctions et non des constantes : les libellés sont traduits, donc
 * dépendants de la requête. Une constante figerait la langue au démarrage du
 * serveur et servirait la même à tout le monde.
 *
 * `t` reçoit une clé de l'espace `nav`. Les appelants sont des composants
 * serveur et passent `await getTranslations("nav")`.
 */
export type Translate = (key: string) => string;

/**
 * Navigation de l'espace client.
 *
 * `access` décide des entrées « Administration » et « Espace revendeur ». Les
 * montrer à tout le monde mènerait à un 404, puisque les mises en page
 * correspondantes refusent les autres rôles : un lien qui ne mène nulle part
 * vaut moins que pas de lien.
 */
export function accountNav(
  t: Translate,
  access: { isAdmin: boolean; isReseller: boolean },
): NavSection[] {
  return [
    {
      label: t("manage"),
      items: [
        // Une seule entrée pour l'accueil : « Accès rapide » et « Tableau de
        // bord » montraient la même chose à deux adresses.
        { label: t("quickAccess"), href: "/", icon: <Gauge /> },
        { label: t("servers"), href: "/servers", icon: <Server /> },
      ],
    },
    {
      label: t("account"),
      items: [
        { label: t("profile"), href: "/account", icon: <User /> },
        { label: t("security"), href: "/account/security", icon: <Shield /> },
        { label: t("apiKeys"), href: "/account/api-keys", icon: <Key /> },
      ],
    },
    {
      label: t("help"),
      items: [
        { label: t("status"), href: "/status", icon: <Activity /> },
        ...(access.isReseller
          ? [{ label: t("resellerSpace"), href: "/reseller", icon: <Store /> }]
          : []),
        ...(access.isAdmin ? [{ label: t("admin"), href: "/admin", icon: <Shield /> }] : []),
        // « DEV » n'est pas traduit : c'est une étiquette technique, identique
        // dans les deux langues, et la traduire n'apporterait rien. Hors
        // production seulement, comme la page elle-même.
        ...(showcaseServed()
          ? [{ label: t("designSystem"), href: "/design", icon: <FileCode2 />, badge: "DEV" }]
          : []),
      ],
    },
  ];
}

/**
 * Navigation de l'espace revendeur.
 *
 * Volontairement courte : un revendeur gère son parc, pas la plateforme. Y
 * recopier les entrées d'administration ferait espérer des écrans que son rôle
 * ne lui ouvre pas.
 */
export function resellerNav(t: Translate): NavSection[] {
  return [
    {
      items: [{ label: t("backToPanel"), href: "/", icon: <LayoutDashboard /> }],
    },
    {
      label: t("myFleet"),
      items: [
        { label: t("overview"), href: "/reseller", icon: <Activity /> },
        { label: t("nodes"), href: "/reseller/nodes", icon: <HardDrive /> },
        { label: t("servers"), href: "/reseller/servers", icon: <Server /> },
        { label: t("clients"), href: "/reseller/clients", icon: <Users /> },
        { label: t("consumption"), href: "/reseller/consumption", icon: <ChartColumn /> },
      ],
    },
    {
      label: t("configuration"),
      items: [
        { label: t("branding"), href: "/reseller/branding", icon: <Palette /> },
        // Sa boutique parle au panel par une clé : c'est ici qu'il l'émet,
        // sans passer par la plateforme.
        { label: t("keys"), href: "/reseller/keys", icon: <Plug /> },
        // Et c'est ici qu'il dit où le panel doit le prévenir, sans avoir à
        // nous le demander.
        { label: t("webhooks"), href: "/reseller/webhooks", icon: <RadioTower /> },
        { label: t("settings"), href: "/reseller/settings", icon: <Settings /> },
      ],
    },
  ];
}

export function adminNav(t: Translate): NavSection[] {
  return [
    {
      items: [{ label: t("backToPanel"), href: "/", icon: <LayoutDashboard /> }],
    },
    {
      label: t("supervision"),
      items: [
        { label: t("overview"), href: "/admin", icon: <Activity /> },
        { label: t("nodes"), href: "/admin/nodes", icon: <HardDrive /> },
        // Les incidents sont rangés avec la supervision : on les rédige en
        // regardant l'état du parc, pas en configurant la plateforme.
        { label: t("incidents"), href: "/admin/incidents", icon: <Siren /> },
        // Le journal est rangé avec la supervision : on l'ouvre pour répondre à
        // « que s'est-il passé », pas pour configurer quoi que ce soit.
        { label: t("audit"), href: "/admin/audit", icon: <History /> },
        // Avec la supervision aussi : on y vient lire ce que le parc a
        // consommé, pour le facturer ou le comprendre.
        { label: t("consumption"), href: "/admin/consumption", icon: <ChartColumn /> },
      ],
    },
    {
      label: t("content"),
      items: [
        { label: t("servers"), href: "/admin/servers", icon: <Server /> },
        { label: t("users"), href: "/admin/users", icon: <Users /> },
        { label: t("catalogue"), href: "/admin/eggs", icon: <Egg /> },
        // Rangé avec le contenu et non la configuration : un hôte de bases est
        // une ressource qu'on ajoute, comme un node ou un egg.
        { label: t("databaseHosts"), href: "/admin/database-hosts", icon: <Database /> },
        { label: t("mounts"), href: "/admin/mounts", icon: <FolderTree /> },
        // Les domaines des revendeurs sont rangés ici plutôt que dans la
        // configuration : la plateforme ne les règle pas, elle les constate —
        // et doit savoir lesquels couvrir d'un certificat.
        { label: t("resellerDomains"), href: "/admin/domains", icon: <Globe /> },
        // Rangées avec le contenu : une annonce est quelque chose qu'on écrit,
        // pas un réglage de la plateforme.
        { label: t("announcements"), href: "/admin/announcements", icon: <Megaphone /> },
      ],
    },
    {
      label: t("configuration"),
      items: [
        { label: t("settings"), href: "/admin/settings", icon: <Settings /> },
        // La référence de l'API vit ici et non dans l'espace client : elle
        // documente aussi les routes d'administration, et rien de ce qu'elle
        // décrit n'est actionnable sans les droits correspondants.
        { label: t("api"), href: "/admin/api", icon: <Plug /> },
      ],
    },
  ];
}

/** Navigation d'un serveur. Reproduit la structure de la capture Pterodactyl. */
export function serverNav(
  id: string,
  t: Translate,
  /** Drapeaux levés. Une entrée retirée ici l'est aussi côté API. */
  features: { marketplace: boolean; snapshots?: boolean } = { marketplace: true },
): NavSection[] {
  const base = `/server/${id}`;
  return [
    {
      items: [
        { label: t("console"), href: base, icon: <Terminal /> },
        { label: t("files"), href: `${base}/files`, icon: <Files /> },
        { label: t("players"), href: `${base}/players`, icon: <UserRound /> },
        // Retirée quand le catalogue est fermé : l'API refuse déjà la route, et
        // laisser l'entrée mènerait à un écran qui ne peut que dire non.
        ...(features.marketplace
          ? [{ label: t("marketplace"), href: `${base}/marketplace`, icon: <Package /> }]
          : []),
        // Le moteur voisine avec les extensions parce que la question est
        // proche, mais reste distinct : l'un remplace ce que le serveur est,
        // l'autre ajoute ce qu'il fait.
        { label: t("engine"), href: `${base}/engine`, icon: <Cpu /> },
      ],
    },
    {
      label: t("management"),
      items: [
        { label: t("databases"), href: `${base}/databases`, icon: <Database /> },
        { label: t("backups"), href: `${base}/backups`, icon: <Archive /> },
        // Seulement là où la machine les offre (agent de node, ADR 0009).
        ...(features.snapshots
          ? [{ label: t("snapshots"), href: `${base}/snapshots`, icon: <Layers /> }]
          : []),
        { label: t("subusers"), href: `${base}/users`, icon: <Users /> },
        { label: t("network"), href: `${base}/network`, icon: <Network /> },
      ],
    },
    {
      label: t("advanced"),
      items: [
        { label: t("schedules"), href: `${base}/schedules`, icon: <Calendar /> },
        // Les rappels sortants voisinent avec les tâches planifiées : les deux
        // font agir quelque chose sans qu'on soit devant l'écran.
        { label: t("webhooks"), href: `${base}/webhooks`, icon: <Webhook /> },
        { label: t("activity"), href: `${base}/activity`, icon: <History /> },
        { label: t("settings"), href: `${base}/settings`, icon: <Settings /> },
      ],
    },
  ];
}
