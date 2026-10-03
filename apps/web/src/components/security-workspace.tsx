"use client";

import { describeUserAgent } from "@gamedashboard/contracts";
import {
  AlertBanner,
  Badge,
  Button,
  type ColumnDef,
  ConfirmDialog,
  DataTable,
  EmptyState,
  PageHeader,
  PageTemplate,
  RelativeTime,
  SettingsSection,
} from "@gamedashboard/ui";
import {
  CircleHelp,
  KeyRound,
  Laptop,
  Shield,
  Smartphone,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useMemo, useState, useTransition } from "react";
import { PasswordForm } from "@/components/password-form";
import { SshKeyList } from "@/components/ssh-key-list";
import { TwoFactorSection } from "@/components/two-factor-section";
import type { Passkey } from "@/server/api/passkeys";
import { type AccountSession, revokeOtherSessions, revokeSession } from "@/server/api/sessions";
import type { SshKey } from "@/server/api/ssh-keys";
import type { TwoFactorStatus } from "@/server/api/two-factor";

/**
 * Sécurité du compte.
 *
 * Les sessions viennent de la base et sont rendues telles quelles : ni ville
 * déduite d'une adresse IP, ni « dernière activité » recalculée à l'affichage.
 * Sur cette page, une valeur approximative n'est pas une approximation — c'est
 * une piste fausse donnée à quelqu'un qui cherche une intrusion.
 */
/**
 * Nomme le moyen d'entrée d'une session.
 *
 * Un moyen inconnu — un fournisseur ajouté plus tard — est rendu tel quel
 * plutôt que traduit en « autre » : lire « github » apprend quelque chose,
 * lire « autre » n'apprend rien.
 */
function methodLabel(t: (key: string) => string, method: string): string {
  const known = new Set(["password", "passkey", "sso", "google", "apiKey"]);
  // `api-key` côté API, `apiKey` côté clés de traduction : les identifiants
  // d'une langue ne portent pas de tiret.
  const key = method === "api-key" ? "apiKey" : method;
  return known.has(key) ? t(`method_${key}`) : method;
}

export function SecurityWorkspace({
  initial,
  twoFactor,
  passkeys,
  sshKeys,
  mobile,
  provisionalPassword = false,
}: {
  initial: AccountSession[];
  twoFactor: TwoFactorStatus;
  passkeys: Passkey[];
  sshKeys: SshKey[];
  /** Application mobile : code QR et téléphones liés (ADR 0010). */
  mobile?: ReactNode;
  /** Arrivé ici depuis la connexion, avec un mot de passe provisoire. */
  provisionalPassword?: boolean;
}) {
  const t = useTranslations("security");
  const tc = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  /**
   * La liste vient du serveur et n'est jamais modifiée en mémoire.
   *
   * Retirer une ligne avant la réponse de l'API montrerait une session fermée
   * qui, en cas de refus, se rouvrirait au rechargement suivant — sur cette
   * page plus qu'ailleurs, croire un appareil déconnecté alors qu'il ne l'est
   * pas est précisément le mensonge à éviter.
   */
  const run = useCallback(
    <T extends { error: string | null }>(
      action: () => Promise<T>,
      done?: (result: T) => string | null,
    ) =>
      startTransition(async () => {
        const result = await action();
        setError(result.error);
        setNotice(result.error ? null : (done?.(result) ?? null));
        if (!result.error) router.refresh();
      }),
    [router],
  );

  /** Nom affichable d'un appareil, composé dans la langue du lecteur. */
  const deviceName = useCallback(
    (session: AccountSession): string => {
      if (session.deviceLabel) return session.deviceLabel;
      const { browser, platform, raw } = describeUserAgent(session.userAgent);
      if (browser && platform) return t("deviceOn", { browser, platform });
      return browser ?? platform ?? raw ?? t("unknownDevice");
    },
    [t],
  );

  const others = initial.filter((session) => !session.isCurrent).length;

  const columns = useMemo<ColumnDef<AccountSession, unknown>[]>(
    () => [
      {
        id: "device",
        header: t("columnDevice"),
        cell: ({ row }) => {
          const session = row.original;
          const { kind } = describeUserAgent(session.userAgent);
          return (
            <div className="flex items-center gap-3">
              {/* L'icône dit la nature de l'appelant : un script n'est pas un
                  ordinateur, et une session dont l'agent n'est pas parvenu
                  jusqu'à nous ne doit pas prendre l'apparence d'un appareil
                  identifié. */}
              <span className="text-muted [&_svg]:size-[18px]">
                {kind === "mobile" ? (
                  <Smartphone />
                ) : kind === "tool" ? (
                  <TerminalSquare />
                ) : kind === "unknown" ? (
                  <CircleHelp />
                ) : (
                  <Laptop />
                )}
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate font-semibold text-fg">
                  {deviceName(session)}
                  {session.isCurrent ? <Badge variant="success">{t("thisDevice")}</Badge> : null}
                </p>
                {/* Ouverture plutôt que localisation : c'est le second repère
                    dont dispose vraiment le panel pour situer une session.
                    Le moyen d'entrée l'accompagne — une session ouverte par
                    mot de passe et une autre par clé d'accès ne se reconnaissent
                    pas autrement, et c'est précisément ce qu'on cherche en
                    relisant cette liste après un doute. */}
                <p className="text-xs text-muted">
                  {t("columnOpened")} <RelativeTime value={session.createdAt} /> ·{" "}
                  {methodLabel(t, session.authMethod)}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "ip",
        header: tc("ipAddress"),
        cell: ({ getValue }) => {
          const ip = getValue() as string | null;
          // Une session ouverte derrière un mandataire mal configuré n'a pas
          // d'adresse enregistrée. Le tiret le dit ; un « 0.0.0.0 » de
          // remplissage se lirait comme une vraie adresse.
          return ip ? (
            <span className="gd-mono text-muted">{ip}</span>
          ) : (
            <span className="text-faint">{tc("none")}</span>
          );
        },
      },
      {
        accessorKey: "lastSeenAt",
        header: t("columnLastSeen"),
        cell: ({ getValue }) => {
          const at = getValue() as string | null;
          return at ? (
            <RelativeTime className="text-muted" value={at} />
          ) : (
            <span className="text-faint">{t("neverSeen")}</span>
          );
        },
      },
      {
        id: "actions",
        header: "",
        size: 130,
        cell: ({ row }) => (
          <Button
            variant="danger-ghost"
            size="sm"
            disabled={pending}
            onClick={() => run(() => revokeSession(row.original.id))}
          >
            <Trash2 />
            {/* Fermer sa propre session, c'est se déconnecter : l'appeler
                « révoquer » ferait cliquer sans voir qu'on se coupe l'accès. */}
            {row.original.isCurrent ? t("signOut") : tc("revoke")}
          </Button>
        ),
      },
    ],
    [t, tc, pending, run, deviceName],
  );

  return (
    <PageTemplate
      header={<PageHeader icon={<Shield />} title={t("title")} subtitle={t("subtitle")} />}
    >
      {error ? (
        <AlertBanner variant="danger" title={tc("actionRefused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}
      {notice ? (
        <AlertBanner variant="success" title={tc("done")} dismissible>
          {notice}
        </AlertBanner>
      ) : null}

      <PasswordForm provisional={provisionalPassword} />

      <TwoFactorSection initial={twoFactor} passkeys={passkeys} />

      {/* Rangées avec la sécurité du compte et non avec un serveur : une clé
          vaut pour tous les serveurs auxquels le compte a droit, présents et
          à venir. La poser sur l'écran d'un serveur ferait croire l'inverse. */}
      <SettingsSection title={t("sshSection")} description={t("sshSectionHint")}>
        <SshKeyList initial={sshKeys} localPassword={twoFactor.localPassword} />
      </SettingsSection>

      {mobile}

      <SettingsSection
        title={t("sessions")}
        description={t("sessionsHint")}
        actions={
          others > 0 ? (
            <Button
              variant="danger-ghost"
              size="sm"
              disabled={pending}
              onClick={() => setRevokeAllOpen(true)}
            >
              <Trash2 /> {t("revokeAll")}
            </Button>
          ) : undefined
        }
      >
        {/* `data-instable-liste` : la liste s'allonge à chaque connexion, y
            compris celles des autres tests ; la suite visuelle la retire de
            ses captures (`e2e/visuel.spec.ts`). */}
        <div data-instable-liste="">
          <DataTable
            columns={columns}
            data={initial}
            getRowId={(row) => row.id}
            className="border-0 shadow-none"
            emptyState={<EmptyState icon={<KeyRound />} title={t("noOtherSession")} />}
          />
        </div>
      </SettingsSection>

      <ConfirmDialog
        open={revokeAllOpen}
        onOpenChange={setRevokeAllOpen}
        title={t("revokeAllTitle")}
        description={t("revokeAllHint")}
        confirmLabel={t("revokeAll")}
        destructive
        onConfirm={() => {
          setRevokeAllOpen(false);
          run(revokeOtherSessions, ({ revoked }) => {
            if (revoked === null) return null;
            return revoked === 0 ? t("revokeAllNone") : t("revokedCount", { count: revoked });
          });
        }}
      />
    </PageTemplate>
  );
}
