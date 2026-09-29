"use client";

import {
  DELEGABLE_ROLE_PRESETS,
  type DelegableRolePreset,
  PERMISSION_GROUPS,
  type RolePresets,
} from "@gamedashboard/contracts";
import {
  AlertBanner,
  Avatar,
  Badge,
  Button,
  type ColumnDef,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DropdownItem,
  DropdownSeparator,
  EmptyState,
  FormField,
  Input,
  PageHeader,
  PageTemplate,
  PermissionMatrix,
  RelativeTime,
  RowActions,
  SelectMenu,
} from "@gamedashboard/ui";
import { Mail, Pencil, Trash2, UserPlus, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  inviteSubuser,
  removeSubuser,
  revokeServerInvite,
  type ServerInvite,
  type Subuser,
  updateSubuser,
} from "@/server/api/subusers";

/** Libellé de chaque préset. « owner » n'en est pas : il ne se délègue pas. */
const PRESET_LABELS: Record<DelegableRolePreset, string> = {
  viewer: "presetViewer",
  moderator: "presetModerator",
  developer: "presetDeveloper",
};

/**
 * Personnes ayant accès au serveur.
 *
 * Les permissions affichées sont celles réellement stockées, jamais recalculées
 * depuis un rôle : redéfinir un préset ne doit pas élargir rétroactivement les
 * droits de quelqu'un invité des mois plus tôt. Le préset ne sert donc qu'à
 * pré-cocher des cases au moment de l'invitation.
 *
 * Les présets viennent de l'API, pas du code : l'administration de la
 * plateforme peut les redéfinir, et le formulaire doit cocher ce qu'elle a
 * décidé.
 */
export function SubusersWorkspace({
  serverId,
  initial,
  invites,
  presets,
}: {
  serverId: string;
  initial: Subuser[];
  invites: ServerInvite[];
  presets: RolePresets;
}) {
  const t = useTranslations("subusers");
  const tc = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // Le node n'a pas confirmé la fermeture de la session SFTP de la personne
  // retirée : l'accès est retiré, mais une session déjà ouverte a pu rester.
  const [sessionLeft, setSessionLeft] = useState(false);
  const [toDelete, setToDelete] = useState<Subuser | null>(null);
  const [editing, setEditing] = useState<Subuser | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [permissions, setPermissions] = useState<string[]>([...presets.moderator]);
  const [pending, startTransition] = useTransition();

  const run = useCallback(
    (
      action: () => Promise<{ error: string | null; sessionsNotClosed?: number }>,
      onDone?: () => void,
    ) =>
      startTransition(async () => {
        const result = await action();
        setSessionLeft((result.sessionsNotClosed ?? 0) > 0);
        setError(result.error);
        if (!result.error) {
          onDone?.();
          router.refresh();
        }
      }),
    [router],
  );

  const columns = useMemo<ColumnDef<Subuser, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: tc("user"),
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <Avatar name={row.original.name} src={row.original.avatarUrl ?? undefined} size="sm" />
            <div className="min-w-0">
              <p className="truncate font-semibold text-fg">{row.original.name}</p>
              <p className="truncate text-xs text-muted">{row.original.email}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: "permissions",
        header: tc("permissions"),
        cell: ({ row }) => (
          <span className="text-muted">
            {t("granted", { count: row.original.permissions.length })}
          </span>
        ),
      },
      {
        accessorKey: "acceptedAt",
        header: tc("status"),
        cell: ({ getValue }) => {
          const at = getValue() as string | null;
          return at ? (
            <span className="text-muted">
              {t("member")} <RelativeTime value={at} />
            </span>
          ) : (
            // Une invitation en attente ne donne aucun droit : le dire plutôt
            // que d'afficher la personne comme membre à part entière.
            <Badge variant="warning">{t("pending")}</Badge>
          );
        },
      },
      {
        id: "actions",
        header: "",
        size: 60,
        cell: ({ row }) => (
          <RowActions>
            <DropdownItem
              icon={<Pencil />}
              disabled={pending}
              onSelect={() => {
                setPermissions(row.original.permissions);
                setEditing(row.original);
              }}
            >
              {t("editPermissions")}
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem icon={<Trash2 />} destructive onSelect={() => setToDelete(row.original)}>
              {t("removeAccess")}
            </DropdownItem>
          </RowActions>
        ),
      },
    ],
    [pending, t, tc],
  );

  const matrix = (
    <PermissionMatrix groups={PERMISSION_GROUPS} value={permissions} onChange={setPermissions} />
  );

  return (
    <PageTemplate
      header={
        <PageHeader
          icon={<Users />}
          title={t("title")}
          subtitle={t("subtitle")}
          actions={
            <Button
              disabled={pending}
              onClick={() => {
                setPermissions([...presets.moderator]);
                setEmail("");
                setInviteOpen(true);
              }}
            >
              <UserPlus /> {tc("invite")}
            </Button>
          }
        />
      }
    >
      {error ? (
        <AlertBanner variant="danger" title={tc("refused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}
      {sessionLeft ? (
        <AlertBanner
          variant="warning"
          title={t("sessionLeftTitle")}
          dismissible
          onDismiss={() => setSessionLeft(false)}
        >
          {t("sessionLeftBody")}
        </AlertBanner>
      ) : null}

      <DataTable
        columns={columns}
        data={initial}
        getRowId={(row) => row.id}
        emptyState={<EmptyState icon={<Users />} title={t("empty")} description={t("emptyHint")} />}
      />

      {/*
        Les invitations par courriel, à part du tableau.

        Elles ne désignent aucun compte : les fondre dans la liste ferait
        apparaître des personnes qui n'existent pas encore, avec des boutons
        « modifier les permissions » ou « retirer l'accès » qui n'auraient rien
        sur quoi agir. La seule action possible est de reprendre sa parole
        avant qu'elle ne soit saisie.
      */}
      {invites.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-semibold text-sm">{t("pendingInvites")}</h2>
          <p className="text-muted text-xs">{t("pendingInvitesHint")}</p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {invites.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Mail className="size-4 text-muted" />
                <span className="gd-mono text-sm">{invite.email}</span>
                <Badge variant="neutral">
                  {t("granted", { count: invite.permissions.length })}
                </Badge>
                <span className="text-muted text-xs">
                  {t("expiresOn", { date: new Date(invite.expiresAt).toLocaleDateString() })}
                </span>
                <Button
                  className="ml-auto"
                  variant="danger-ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => revokeServerInvite(serverId, invite.id))}
                >
                  <Trash2 /> {t("revokeInvite")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent
          size="lg"
          title={t("inviteTitle")}
          description={t("inviteBody")}
          footer={
            <>
              <Button variant="secondary" onClick={() => setInviteOpen(false)}>
                {tc("cancel")}
              </Button>
              <Button
                disabled={!email.includes("@") || pending}
                onClick={() =>
                  run(
                    () => inviteSubuser(serverId, email.trim(), permissions),
                    () => setInviteOpen(false),
                  )
                }
              >
                {t("sendInvite")}
              </Button>
            </>
          }
        >
          <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={tc("email")}>
                {(id) => (
                  <Input
                    id={id}
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("emailPlaceholder")}
                    leadingIcon={<Mail />}
                  />
                )}
              </FormField>
              <FormField label={t("preset")} description={t("presetHint")}>
                {(id) => (
                  <SelectMenu
                    id={id}
                    value=""
                    onValueChange={(v) => setPermissions([...presets[v as DelegableRolePreset]])}
                    // Le nombre de cases plutôt qu'une description figée :
                    // l'administration peut redéfinir un préset, et « consultation
                    // seule » deviendrait alors un mensonge affiché à l'écran.
                    options={DELEGABLE_ROLE_PRESETS.map((preset) => ({
                      value: preset,
                      label: t(PRESET_LABELS[preset]),
                      description: t("presetCount", { count: presets[preset].length }),
                    }))}
                  />
                )}
              </FormField>
            </div>
            {matrix}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent
          size="lg"
          title={t("editTitle")}
          description={editing ? t("editBody", { name: editing.name }) : undefined}
          footer={
            <>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                {tc("cancel")}
              </Button>
              <Button
                disabled={pending}
                onClick={() => {
                  const target = editing;
                  if (target) {
                    run(
                      () => updateSubuser(serverId, target.id, permissions),
                      () => setEditing(null),
                    );
                  }
                }}
              >
                {tc("save")}
              </Button>
            </>
          }
        >
          <div className="max-h-[60vh] overflow-y-auto">{matrix}</div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={t("removeTitle")}
        description={toDelete ? t("removeBody", { name: toDelete.name }) : undefined}
        confirmLabel={tc("remove")}
        destructive
        onConfirm={() => {
          const target = toDelete;
          setToDelete(null);
          if (target) run(() => removeSubuser(serverId, target.id));
        }}
      />
    </PageTemplate>
  );
}
