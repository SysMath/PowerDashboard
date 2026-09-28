"use client";

import {
  AlertBanner,
  Button,
  ConfirmDialog,
  FormField,
  formatMb,
  Input,
  KeyValueGrid,
  PageHeader,
  PageTemplate,
  SelectMenu,
  SettingsSection,
} from "@gamedashboard/ui";
import { RotateCcw, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useState, useTransition } from "react";
import {
  reinstallServer,
  renameServer,
  type ServerSettings,
  setDockerImage as saveDockerImage,
  saveVariables,
} from "@/server/api/settings";
import { ServerBlockBanner, useReinstallBlocked, useServerBlock } from "./server-block-context";

/**
 * Paramètres d'un serveur.
 *
 * Trois natures de réglage, délibérément séparées : ce que le client décide
 * (nom, variables), ce que son offre impose (ressources), et ce qui détruit
 * des données (réinstallation). Les mélanger ferait cliquer sur la troisième
 * en croyant toucher à la première.
 */
export function SettingsWorkspace({
  serverId,
  initial,
}: {
  serverId: string;
  initial: ServerSettings;
}) {
  const t = useTranslations("serverSettings");
  const tc = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(initial.variables.map((v) => [v.envVariable, v.value])),
  );
  const [reinstallOpen, setReinstallOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [dockerImage, setDockerImage] = useState(initial.dockerImage);
  /*
   * Deux mesures, pas une.
   *
   * L'image du conteneur se change au prochain démarrage et l'API la refuse
   * sur un serveur bloqué. La réinstallation, elle, est le remède d'une
   * installation échouée : la griser dans cet état renverrait le lecteur vers
   * le bouton qu'on vient de lui retirer, deux lignes sous un bandeau qui lui
   * dit d'appuyer dessus.
   */
  const bloc = useServerBlock();
  const reinstallFige = useReinstallBlocked();

  const run = useCallback(
    (action: () => Promise<{ error: string | null }>, label: string) =>
      startTransition(async () => {
        const result = await action();
        setError(result.error);
        // « Enregistré » n'apparaît qu'après confirmation de l'API : l'afficher
        // avant ferait quitter la page à quelqu'un dont la modification n'a
        // jamais atteint la base.
        setSaved(result.error ? null : label);
        if (!result.error) router.refresh();
      }),
    [router],
  );

  const editable = initial.variables.filter((v) => v.isEditable);

  return (
    <PageTemplate
      notice={<ServerBlockBanner />}
      header={
        <PageHeader
          icon={<Settings />}
          title={t("title")}
          subtitle={t("subtitle")}
          breadcrumbs={[{ label: t("myServers"), href: "/servers" }, { label: initial.name }]}
        />
      }
    >
      {error ? (
        <AlertBanner variant="danger" title={tc("refused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}
      {saved ? (
        <AlertBanner variant="success" title={tc("saved")} dismissible>
          {saved}
        </AlertBanner>
      ) : null}

      <SettingsSection
        title={t("identity")}
        description={t("identityHint")}
        footer={
          <Button
            disabled={name.trim() === "" || pending}
            onClick={() => run(() => renameServer(serverId, name, description), t("savedName"))}
          >
            {tc("save")}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label={t("serverName")}>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <FormField label={t("description")} description={t("descriptionHint")}>
            {(id) => (
              <Input
                id={id}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
              />
            )}
          </FormField>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("variables")}
        description={t("variablesHint")}
        footer={
          editable.length > 0 ? (
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    saveVariables(
                      serverId,
                      // Seules les variables modifiables sont envoyées : l'API
                      // refuse les autres, et les inclure ferait échouer
                      // l'enregistrement entier pour un champ grisé.
                      Object.fromEntries(
                        editable.map((v) => [v.envVariable, values[v.envVariable] ?? v.value]),
                      ),
                    ),
                  t("savedVariables"),
                )
              }
            >
              {tc("save")}
            </Button>
          ) : undefined
        }
      >
        {initial.variables.length === 0 ? (
          <p className="text-sm text-muted">{t("noVariables")}</p>
        ) : (
          <div className="flex flex-col gap-5">
            {initial.variables.map((v) => (
              <FormField
                key={v.envVariable}
                label={v.name}
                description={[v.description, v.envVariable].filter(Boolean).join(" — ")}
              >
                {(id) => (
                  <Input
                    id={id}
                    className="gd-mono"
                    value={values[v.envVariable] ?? v.value}
                    // Le champ est grisé côté écran, et l'API refuse de toute
                    // façon l'écriture : la règle vit des deux côtés parce que
                    // seul le second est opposable.
                    disabled={!v.isEditable || pending}
                    onChange={(e) =>
                      setValues((current) => ({ ...current, [v.envVariable]: e.target.value }))
                    }
                  />
                )}
              </FormField>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t("sftp")} description={t("sftpHint")}>
        {/* Annoncé fermé si le panel ne sert pas l'authentification : afficher
            des identifiants qui seront refusés ferait perdre une demi-heure à
            qui essaie. */}
        {!initial.sftpIsOpen ? (
          <AlertBanner variant="warning" title={t("sftpClosed")}>
            {t("sftpClosedBody")}
          </AlertBanner>
        ) : null}
        <KeyValueGrid
          items={[
            {
              label: t("host"),
              value: (
                <span className="gd-mono">
                  sftp://{initial.sftpHost}:{initial.sftpPort}
                </span>
              ),
            },
            {
              label: tc("user"),
              value: <span className="gd-mono">{initial.sftpUsername}</span>,
            },
            {
              label: tc("password"),
              value: initial.sftpPasswordAccepted
                ? t("samePasswordAsAccount")
                : t("sftpPasswordRefused"),
            },
            { label: t("directory"), value: <span className="gd-mono">/home/container</span> },
          ]}
        />

        {/* La clé plutôt que le mot de passe : un client SFTP garde ce qu'on lui
            confie, et le mot de passe du compte ouvre bien plus que des
            fichiers. Dit ici, où la question se pose. */}
        {/* Annuaire obligatoire : la clé n'est plus un conseil mais le seul
            chemin. Le client SFTP ne dira qu'« authentification refusée » ;
            c'est ici que l'on apprend quoi faire. */}
        {initial.sftpIsOpen && !initial.sftpPasswordAccepted ? (
          <AlertBanner variant="warning" title={t("sftpKeyOnly")}>
            {t("sftpKeyOnlyBody")}{" "}
            <Link href="/account/security" className="font-semibold text-accent hover:underline">
              {t("sftpKeyOnlyLink")}
            </Link>
          </AlertBanner>
        ) : null}
        {initial.sftpIsOpen && initial.sftpPasswordAccepted ? (
          <p className="text-muted text-xs">
            {t("sftpKeyHint")}{" "}
            <Link href="/account/security" className="font-semibold text-accent hover:underline">
              {t("sftpKeyLink")}
            </Link>
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("resources")} description={t("resourcesHint")}>
        <KeyValueGrid
          items={[
            { label: t("memory"), value: formatMb(initial.memoryMb, 0) },
            { label: tc("disk"), value: formatMb(initial.diskMb, 0) },
            {
              // 0 % signifie « sans limite » dans Wings, pas « aucun CPU » :
              // afficher « 0 % » laisserait croire que le serveur ne tourne pas.
              label: "CPU",
              value: initial.cpuPct === 0 ? t("unlimited") : `${initial.cpuPct} %`,
            },
            {
              label: t("swap"),
              value: initial.swapMb === 0 ? t("swapDisabled") : formatMb(initial.swapMb, 0),
            },
            { label: t("game"), value: initial.eggName },
            { label: t("node"), value: initial.nodeName },
            { label: t("address"), value: <span className="gd-mono">{initial.address}</span> },
          ]}
        />
      </SettingsSection>

      {/*
       * L'image de conteneur, **choisie dans ce que l'egg déclare**.
       *
       * Liste fermée et non champ libre : une image arbitraire sortirait du
       * catalogue éprouvé par l'auteur de l'egg, et ferait tirer au daemon une
       * adresse que personne n'a vérifiée. Le champ libre existe, mais sur la
       * fiche d'administration, pour quelqu'un qui répond de la machine.
       *
       * Rien n'est proposé quand l'egg ne déclare qu'une image : un choix à une
       * seule option n'est pas un choix.
       */}
      {Object.keys(initial.eggImages).length > 1 ? (
        <SettingsSection title={t("dockerImage")} description={t("dockerImageHint")}>
          <SelectMenu
            className="max-w-xl"
            value={dockerImage}
            disabled={pending || bloc !== null}
            onValueChange={(next) => {
              setDockerImage(next);
              run(() => saveDockerImage(serverId, next), t("savedDockerImage"));
            }}
            options={Object.entries(initial.eggImages).map(([label, image]) => ({
              value: image,
              label: `${label} — ${image}`,
            }))}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection tone="danger" title={t("dangerZone")} description={t("dangerZoneHint")}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-fg">{t("reinstallServer")}</p>
            <p className="text-xs text-muted">{t("reinstallHint")}</p>
          </div>
          <Button
            variant="danger"
            disabled={pending || reinstallFige}
            onClick={() => setReinstallOpen(true)}
          >
            <RotateCcw /> {t("reinstall")}
          </Button>
        </div>
      </SettingsSection>

      <ConfirmDialog
        open={reinstallOpen}
        onOpenChange={setReinstallOpen}
        title={t("reinstallTitle")}
        description={t("reinstallBody")}
        confirmLabel={t("reinstall")}
        destructive
        requireTyped={initial.name}
        onConfirm={() => {
          setReinstallOpen(false);
          run(() => reinstallServer(serverId), t("reinstallStarted"));
        }}
      />
    </PageTemplate>
  );
}
