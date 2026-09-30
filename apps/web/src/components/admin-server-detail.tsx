"use client";

import { reinstallBlocked } from "@gamedashboard/contracts";
import {
  AlertBanner,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  DialogContent,
  FormField,
  formatMb,
  Input,
  KeyValueGrid,
  PageHeader,
  PageTemplate,
  SelectMenu,
  SettingToggle,
} from "@gamedashboard/ui";
import {
  ArrowRightLeft,
  ExternalLink,
  Replace,
  Save,
  Server,
  SlidersHorizontal,
  TriangleAlert,
  UserCog,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import type { AdminNode } from "@/server/api/admin";
import { setServerLimits, setServerOwner } from "@/server/api/admin-actions";
import {
  type AdminServerDetail,
  setServerEgg,
  setServerRuntime,
  setServerVariable,
  transferServer,
} from "@/server/api/admin-server";

/**
 * Fiche d'administration d'un serveur.
 *
 * Elle porte ce que l'espace client ne donne pas — image de conteneur et
 * commande de démarrage libres — parce qu'un hébergeur en a besoin et qu'un
 * client, non : une commande libre permet d'exécuter ce qu'on veut dans le
 * conteneur.
 *
 * Le bloc le plus important n'est pas un champ mais un **affichage** : la
 * commande résolue, gabarits remplacés. Le panel remet au daemon une
 * invocation et un environnement ; ce qui tourne est le résultat des deux, et
 * ne montrer que le gabarit a coûté un serveur qui lançait `java -jar` sans
 * rien derrière, sans que rien à l'écran ne le dise.
 */
/**
 * Les sept quantités qui composent une offre.
 *
 * Déclarées en liste plutôt qu'en sept champs recopiés : sept blocs identiques
 * à deux mots près finissent par diverger — l'un garde un ancien libellé,
 * l'autre oublie une aide.
 */
const LIMIT_FIELDS = [
  { key: "memoryMb", label: "memory", hint: "memoryHint" },
  { key: "diskMb", label: "disk", hint: "diskHint" },
  { key: "swapMb", label: "swap", hint: "swapHint" },
  { key: "cpuPct", label: "cpu", hint: "cpuHint" },
  { key: "backups", label: "backupLimit", hint: "backupLimitHint" },
  { key: "databases", label: "databaseLimit", hint: "databaseLimitHint" },
  { key: "allocations", label: "allocationLimit", hint: "allocationLimitHint" },
] as const;

/**
 * Une quantité saisie est-elle exploitable ?
 *
 * Zéro est accepté ici, contrairement à l'écran du revendeur : sur cette
 * fiche, `cpuPct` à zéro veut dire « sans limite de processeur », et un swap
 * ou un quota de sauvegardes à zéro sont des réglages ordinaires. C'est l'API
 * qui tranche les bornes ; celui-ci n'écarte que ce qui n'est pas un nombre.
 */
function entier(valeur: string): boolean {
  return valeur.trim() !== "" && Number.isInteger(Number(valeur)) && Number(valeur) >= 0;
}

export function AdminServerDetailView({
  server,
  nodes,
  owners,
  eggs,
}: {
  server: AdminServerDetail;
  nodes: AdminNode[];
  /** Les comptes qui peuvent recevoir ce serveur. */
  owners: { id: string; name: string; email: string }[];
  /** Les jeux disponibles, déjà filtrés sur ceux qu'un administrateur a activés. */
  eggs: { id: string; name: string; nest: string }[];
}) {
  const t = useTranslations("adminServerDetail");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [dockerImage, setDockerImage] = useState(server.dockerImage);
  const [startup, setStartup] = useState(server.startup);
  const [oomKiller, setOomKiller] = useState(server.resources.oomKiller);
  const [transferOpen, setTransferOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [ownerId, setOwnerId] = useState("");
  // Le bandeau du dernier changement de propriétaire, écarté pour cette visite
  // seulement : il revient tant que le reste n'est pas nettoyé.
  const [cleanupDismissed, setCleanupDismissed] = useState(false);
  const leftovers = cleanupDismissed ? null : server.ownerChange;
  /*
   * Les limites, gardées en texte pendant la saisie.
   *
   * Un champ vidé pour être retapé vaut `NaN` si on le convertit à chaque
   * frappe, et le bouton se grise sous les doigts de celui qui écrit.
   */
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [limits, setLimits] = useState<Record<string, string>>({});

  // Le node courant est retiré de la liste : « déplacer vers là où il est
  // déjà » n'est pas un choix, et l'API le refuserait.
  const destinations = nodes.filter((node) => node.id !== server.node.id);
  const [destination, setDestination] = useState(destinations[0]?.id ?? "");

  // Même raison pour le jeu courant : l'API refuse « changer pour le même ».
  const autresJeux = eggs.filter((egg) => egg.id !== server.egg.id);
  /*
   * La même règle que la réinstallation, et pas « state !== null ».
   *
   * Une installation échouée **n'est pas** un blocage ici : c'est au contraire
   * l'état d'où l'on veut pouvoir repartir sur un autre jeu. Écrire la
   * condition à la main l'aurait oublié, et l'écran aurait grisé le seul
   * bouton capable de réparer.
   */
  const bloque = reinstallBlocked(server.state);
  const [eggId, setEggId] = useState("");
  const [eggReinstall, setEggReinstall] = useState(true);
  const [eggOpen, setEggOpen] = useState(false);
  const [variables, setVariables] = useState<Record<string, string>>(
    Object.fromEntries(server.variables.map((v) => [v.envVariable, v.value])),
  );

  const run = (action: () => Promise<{ error: string | null }>) =>
    startTransition(async () => {
      const result = await action();
      setError(result.error);
      if (!result.error) router.refresh();
    });

  /*
   * Les images proposées viennent de l'egg, et le champ reste libre.
   *
   * La liste couvre le cas courant sans enfermer : un hébergeur qui maintient
   * sa propre image doit pouvoir l'écrire. Fermer le champ l'obligerait à
   * modifier l'egg pour un seul serveur.
   */
  const imageOptions = Object.entries(server.egg.images).map(([label, image]) => ({
    value: image,
    label: `${label} — ${image}`,
  }));

  return (
    <PageTemplate
      header={
        <PageHeader
          icon={<Server />}
          title={server.name}
          subtitle={t("subtitle", { egg: server.egg.name, node: server.node.name })}
          actions={
            <Button variant="secondary" asChild>
              <Link href={`/server/${server.id}`}>
                <ExternalLink /> {t("openClientView")}
              </Link>
            </Button>
          }
        />
      }
    >
      {error ? (
        <AlertBanner variant="danger" title={tc("actionRefused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}
      {leftovers ? (
        <AlertBanner
          variant="warning"
          title={t("ownerCleanupTitle")}
          dismissible
          onDismiss={() => setCleanupDismissed(true)}
        >
          {leftovers.cleanupMissing ? <p>{t("ownerCleanupMissing")}</p> : null}
          {leftovers.databasesNotRotated.length > 0 ? (
            <p>{t("ownerCleanupDatabases", { names: leftovers.databasesNotRotated.join(", ") })}</p>
          ) : null}
          {leftovers.sessionsNotClosed > 0 ? (
            <p>{t("ownerCleanupSessions", { count: leftovers.sessionsNotClosed })}</p>
          ) : null}
        </AlertBanner>
      ) : null}

      <Card>
        <CardHeader title={t("identity")} />
        <CardBody>
          <KeyValueGrid
            items={[
              { label: t("shortId"), value: <span className="gd-mono">{server.shortId}</span> },
              {
                label: t("owner"),
                /*
                 * La seule ligne modifiable de cette carte, et c'est voulu.
                 *
                 * L'identifiant court est le nom du serveur pour le daemon et
                 * pour tous les journaux déjà écrits ; la machine se change par
                 * un transfert, qui arrête le serveur et lui fait changer
                 * d'adresse ; l'état de gestion se déduit, il ne se pose pas.
                 * Le propriétaire, lui, n'avait aucun moyen de changer — il
                 * fallait passer par la base.
                 */
                value: (
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{`${server.owner.name} · ${server.owner.email}`}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setOwnerId("");
                        setOwnerOpen(true);
                      }}
                    >
                      <UserCog /> {t("changeOwner")}
                    </Button>
                  </span>
                ),
              },
              { label: t("node"), value: `${server.node.name} · ${server.node.fqdn}` },
              { label: t("egg"), value: server.egg.name },
              {
                label: t("state"),
                // `null` veut dire « rien de particulier », donc installé et à
                // l'arrêt ou en marche : c'est l'état de gestion, pas celui du
                // conteneur, que seul le daemon connaît.
                value: server.state ?? t("stateNormal"),
              },
              {
                label: t("ports"),
                value: server.ports.length
                  ? server.ports
                      .map((p) => `${p.ip}:${p.port}${p.isDefault ? ` (${t("portDefault")})` : ""}`)
                      .join(", ")
                  : t("noPort"),
              },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("runtime")} description={t("runtimeHint")} />
        <CardBody className="flex flex-col gap-5">
          {/*
           * Ce que le conteneur lancera réellement, et non le gabarit.
           *
           * Un gabarit non renseigné disparaît — Wings le remplace par du vide,
           * il ne le laisse pas tel quel. C'est ce qui donne `-jar` suivi de
           * rien, et c'est exactement ce que cette ligne rend visible avant le
           * démarrage plutôt qu'après.
           */}
          <div className="flex flex-col gap-2">
            <span className="font-semibold text-fg text-sm">{t("resolved")}</span>
            <code className="gd-mono select-all break-all rounded-field border border-border bg-surface-2 p-3 text-fg text-xs">
              {server.resolvedStartup}
            </code>
            {server.unresolvedPlaceholders.length > 0 ? (
              <AlertBanner variant="warning" title={t("unresolvedTitle")}>
                {t("unresolvedBody", { names: server.unresolvedPlaceholders.join(", ") })}
              </AlertBanner>
            ) : null}
          </div>

          <FormField label={t("dockerImage")} description={t("dockerImageHint")}>
            {(id) => (
              <div className="flex flex-col gap-2">
                {imageOptions.length > 0 ? (
                  <SelectMenu
                    value={imageOptions.some((o) => o.value === dockerImage) ? dockerImage : ""}
                    onValueChange={setDockerImage}
                    options={[
                      { value: "", label: t("customImage"), disabled: true },
                      ...imageOptions,
                    ]}
                  />
                ) : null}
                <Input
                  id={id}
                  value={dockerImage}
                  onChange={(e) => setDockerImage(e.target.value)}
                />
              </div>
            )}
          </FormField>

          <FormField label={t("startup")} description={t("startupHint")}>
            {(id) => (
              <Input
                id={id}
                className="gd-mono text-xs"
                value={startup}
                onChange={(e) => setStartup(e.target.value)}
              />
            )}
          </FormField>

          {/*
           * Le tueur de mémoire est ici et nulle part ailleurs.
           *
           * Le désactiver laisse un conteneur dépasser sa limite sans jamais
           * être arrêté : cela n'engage pas seulement le serveur, mais ses
           * voisins de machine. C'est donc une décision d'hébergeur, et
           * l'espace client ne la propose plus. L'état par défaut des serveurs
           * créés ensuite se règle dans les paramètres de la plateforme.
           */}
          <SettingToggle
            label={t("oomKiller")}
            description={t("oomKillerHint")}
            checked={oomKiller}
            disabled={pending}
            onCheckedChange={setOomKiller}
          />

          <Button
            className="self-start"
            disabled={
              pending ||
              (dockerImage === server.dockerImage &&
                startup === server.startup &&
                oomKiller === server.resources.oomKiller)
            }
            onClick={() =>
              run(() => setServerRuntime(server.id, { dockerImage, startup, oomKiller }))
            }
          >
            <Save /> {t("saveRuntime")}
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("variables")} description={t("variablesHint")} />
        <CardBody className="flex flex-col gap-4">
          {server.variables.length === 0 ? (
            <p className="text-muted text-sm">{t("noVariable")}</p>
          ) : (
            server.variables.map((variable) => (
              <div key={variable.envVariable} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-fg text-sm">{variable.name}</span>
                  <code className="gd-mono text-faint text-xs">{variable.envVariable}</code>
                  {/* Dire ce que le client peut en faire : c'est la raison
                      d'être de cet écran d'y toucher quand même. */}
                  {!variable.userEditable ? (
                    <Badge variant="warning">
                      <TriangleAlert className="size-3" /> {t("locked")}
                    </Badge>
                  ) : null}
                  {!variable.userViewable ? <Badge variant="neutral">{t("hidden")}</Badge> : null}
                </div>
                {variable.description ? (
                  <p className="text-muted text-xs">{variable.description}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Input
                    className="min-w-56 flex-1 gd-mono text-xs"
                    value={variables[variable.envVariable] ?? ""}
                    onChange={(e) =>
                      setVariables((current) => ({
                        ...current,
                        [variable.envVariable]: e.target.value,
                      }))
                    }
                  />
                  <Button
                    variant="secondary"
                    disabled={pending || variables[variable.envVariable] === variable.value}
                    onClick={() =>
                      run(() =>
                        setServerVariable(
                          server.id,
                          variable.envVariable,
                          variables[variable.envVariable] ?? "",
                        ),
                      )
                    }
                  >
                    {tc("save")}
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      {/*
       * Le déplacement, et ce qu'il coûte.
       *
       * Trois conséquences, dites avant le clic plutôt que découvertes après :
       * le serveur s'arrête, il change d'adresse — un port appartient à une
       * machine — et l'opération dure le temps de copier son disque. C'est
       * aussi pourquoi ce bloc est à part et non parmi les champs d'exécution :
       * enregistrer une image de conteneur et déménager un serveur ne se font
       * pas du même geste.
       */}
      <Card>
        <CardHeader title={t("transfer")} description={t("transferHint")} />
        <CardBody className="flex flex-col gap-4">
          {destinations.length === 0 ? (
            <p className="text-muted text-sm">{t("noDestination")}</p>
          ) : (
            <>
              <FormField label={t("destination")}>
                {(id) => (
                  <SelectMenu
                    id={id}
                    className="max-w-xl"
                    value={destination}
                    disabled={pending || server.state !== null}
                    onValueChange={setDestination}
                    options={destinations.map((node) => ({
                      value: node.id,
                      label: `${node.name} — ${node.fqdn}`,
                      // Un node en maintenance refusera : le proposer sans le
                      // dire ferait cliquer pour rien.
                      disabled: node.maintenance,
                    }))}
                  />
                )}
              </FormField>
              {/* Un serveur occupé ne se déménage pas : le dire ici évite un
                  refus de l'API qu'on lirait comme une panne. */}
              {server.state !== null ? (
                <AlertBanner variant="warning" title={t("transferBusy")}>
                  {t("transferBusyBody", { state: server.state })}
                </AlertBanner>
              ) : null}
              <Button
                className="self-start"
                variant="secondary"
                disabled={pending || destination === "" || server.state !== null}
                onClick={() => setTransferOpen(true)}
              >
                <ArrowRightLeft /> {t("transferAction")}
              </Button>
            </>
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        title={t("transferConfirmTitle")}
        description={t("transferConfirmBody", {
          node: destinations.find((n) => n.id === destination)?.name ?? "",
        })}
        confirmLabel={t("transferAction")}
        onConfirm={() => {
          setTransferOpen(false);
          run(() => transferServer(server.id, destination));
        }}
      />

      {/*
       * Changer de jeu, sans supprimer le serveur.
       *
       * Jusqu'ici il fallait résilier et recommander : le client perdait son
       * identifiant court, ses sous-utilisateurs, ses planifications et son
       * historique pour changer un jar. Ce qui part quand même est écrit dans
       * l'écran, avant le clic, parce que cela ne se rattrape pas après : les
       * variables de l'ancien jeu, la commande de démarrage et l'image.
       */}
      <Card>
        <CardHeader title={t("changeEgg")} description={t("changeEggHint")} />
        <CardBody className="flex flex-col gap-4">
          {autresJeux.length === 0 ? (
            <p className="text-muted text-sm">{t("noOtherEgg")}</p>
          ) : (
            <>
              <FormField label={t("newEgg")} description={t("newEggHint")}>
                {(id) => (
                  <SelectMenu
                    id={id}
                    className="max-w-xl"
                    value={eggId}
                    disabled={pending || bloque}
                    onValueChange={setEggId}
                    options={[
                      { value: "", label: t("chooseEgg"), disabled: true },
                      ...autresJeux.map((egg) => ({
                        value: egg.id,
                        label: `${egg.nest} — ${egg.name}`,
                      })),
                    ]}
                  />
                )}
              </FormField>

              {/*
               * La réinstallation est cochée d'avance, et c'est un choix.
               *
               * Un serveur qui porte le nom d'un jeu dont aucun fichier n'est
               * présent ne démarre pas, et rien à l'écran ne dirait pourquoi.
               * La décocher reste possible — réparer une fiche sans toucher au
               * volume — mais c'est alors une décision prise, pas un oubli.
               */}
              <SettingToggle
                label={t("eggReinstall")}
                description={t("eggReinstallHint")}
                checked={eggReinstall}
                disabled={pending || bloque}
                onCheckedChange={setEggReinstall}
              />

              <AlertBanner
                variant={eggReinstall ? "danger" : "warning"}
                title={eggReinstall ? t("eggWipeTitle") : t("eggKeepTitle")}
              >
                {eggReinstall ? t("eggWipeBody") : t("eggKeepBody")}
              </AlertBanner>

              {/* Un serveur occupé est refusé par l'API : le dire ici évite de
                  lire ce refus comme une panne. */}
              {bloque ? (
                <AlertBanner variant="warning" title={t("transferBusy")}>
                  {t("transferBusyBody", { state: server.state ?? "" })}
                </AlertBanner>
              ) : null}

              <Button
                className="self-start"
                variant="secondary"
                disabled={pending || eggId === "" || bloque}
                onClick={() => setEggOpen(true)}
              >
                <Replace /> {t("changeEggAction")}
              </Button>
            </>
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={eggOpen}
        onOpenChange={setEggOpen}
        title={t("changeEggConfirmTitle")}
        description={
          eggReinstall
            ? t("changeEggConfirmWipe", { egg: autresJeux.find((e) => e.id === eggId)?.name ?? "" })
            : t("changeEggConfirmKeep", { egg: autresJeux.find((e) => e.id === eggId)?.name ?? "" })
        }
        confirmLabel={t("changeEggAction")}
        onConfirm={() => {
          setEggOpen(false);
          run(() => setServerEgg(server.id, eggId, eggReinstall));
        }}
      />

      <Card>
        <CardHeader
          title={t("resources")}
          actions={
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => {
                setLimits({
                  memoryMb: String(server.resources.memoryMb),
                  diskMb: String(server.resources.diskMb),
                  swapMb: String(server.resources.swapMb),
                  cpuPct: String(server.resources.cpuPct),
                  backups: String(server.limits.backups),
                  databases: String(server.limits.databases),
                  allocations: String(server.limits.allocations),
                });
                setLimitsOpen(true);
              }}
            >
              <SlidersHorizontal /> {t("editLimits")}
            </Button>
          }
        />
        <CardBody>
          <KeyValueGrid
            items={[
              { label: t("memory"), value: formatMb(server.resources.memoryMb, 0) },
              { label: t("disk"), value: formatMb(server.resources.diskMb, 0) },
              { label: t("swap"), value: formatMb(server.resources.swapMb, 0) },
              { label: t("cpu"), value: `${server.resources.cpuPct} %` },
              { label: t("ioWeight"), value: String(server.resources.ioWeight) },
              { label: t("threads"), value: server.resources.threads ?? t("threadsAll") },
              {
                label: t("limits"),
                value: t("limitsValue", {
                  backups: server.limits.backups,
                  databases: server.limits.databases,
                  allocations: server.limits.allocations,
                }),
              },
            ]}
          />
        </CardBody>
      </Card>
      <Dialog open={limitsOpen} onOpenChange={setLimitsOpen}>
        <DialogContent
          title={t("editLimitsTitle")}
          description={t("editLimitsHint")}
          footer={
            <Button
              disabled={pending || !Object.values(limits).every(entier)}
              onClick={() => {
                const valeurs = limits;
                setLimitsOpen(false);
                run(() =>
                  setServerLimits(server.id, {
                    memoryMb: Number(valeurs.memoryMb),
                    diskMb: Number(valeurs.diskMb),
                    swapMb: Number(valeurs.swapMb),
                    cpuPct: Number(valeurs.cpuPct),
                    backups: Number(valeurs.backups),
                    databases: Number(valeurs.databases),
                    allocations: Number(valeurs.allocations),
                  }),
                );
              }}
            >
              {tc("save")}
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {LIMIT_FIELDS.map((champ) => (
              <FormField key={champ.key} label={t(champ.label)} description={t(champ.hint)}>
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={limits[champ.key] ?? ""}
                    onChange={(e) =>
                      setLimits((prev) => ({ ...prev, [champ.key]: e.target.value }))
                    }
                  />
                )}
              </FormField>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={ownerOpen} onOpenChange={setOwnerOpen}>
        <DialogContent
          title={t("changeOwnerTitle")}
          description={t("changeOwnerHint")}
          footer={
            <Button
              disabled={pending || ownerId === "" || ownerId === server.owner.id}
              onClick={() => {
                const cible = ownerId;
                setOwnerOpen(false);
                setCleanupDismissed(false);
                run(() => setServerOwner(server.id, cible));
              }}
            >
              {tc("save")}
            </Button>
          }
        >
          {/*
            Le destinataire se choisit dans la liste des comptes, pas en
            recopiant un identifiant : un UUID mal collé désignerait quelqu'un
            d'autre, et rien à l'écran ne le dirait avant que le serveur ait
            changé de mains.
          */}
          <FormField label={t("owner")} description={t("changeOwnerFieldHint")}>
            {(id) => (
              <SelectMenu
                id={id}
                value={ownerId}
                onValueChange={setOwnerId}
                placeholder={t("changeOwnerPlaceholder")}
                options={owners.map((o) => ({
                  value: o.id,
                  label: `${o.name} · ${o.email}`,
                }))}
              />
            )}
          </FormField>
        </DialogContent>
      </Dialog>
    </PageTemplate>
  );
}
