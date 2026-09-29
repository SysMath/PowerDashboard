"use client";

import {
  AlertBanner,
  Badge,
  Button,
  type ColumnDef,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  EmptyState,
  FormField,
  formatMb,
  Input,
  PageHeader,
  PageTemplate,
  RelativeTime,
  StatusDot,
} from "@gamedashboard/ui";
import { Pause, Play, Search, Server, SlidersHorizontal, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState, useTransition } from "react";
import type { ResellerServer } from "@/server/api/reseller";
import {
  deleteResellerServer,
  setResellerServerLimits,
  setResellerServerSuspended,
} from "@/server/api/reseller-fleet";

/**
 * Serveurs hébergés sur les machines du revendeur.
 *
 * L'écran était en lecture seule, au motif que ces serveurs appartiennent à
 * ses clients. Le motif était juste, la conséquence non : un hébergeur doit
 * pouvoir suspendre un impayé et rendre un serveur résilié, sans quoi il n'est
 * pas hébergeur. Ces gestes n'existaient que pour sa boutique, par clé
 * applicative — un revendeur sans boutique ne pouvait rien.
 *
 * Trois gestes, et trois seulement. Ouvrir la console ou les fichiers d'un
 * client ne se fait pas d'ici : cela passe par la fiche du serveur, où les
 * permissions s'appliquent une par une.
 */
/**
 * Les sept quantités d'une offre, et ce que chacune tolère.
 *
 * Le dialogue n'en proposait que deux — mémoire et disque — parce que la
 * liste du parc ne transportait que celles-là. Un revendeur devait donc
 * passer par l'API ou demander à la plateforme pour changer un processeur ou
 * un plafond de sauvegardes, alors que c'est son métier.
 *
 * `zeroPermis` n'est pas un détail de saisie : sur ces quatre-là, zéro est un
 * réglage ordinaire — pas de swap, aucune sauvegarde autorisée, processeur
 * sans limite. Sur la mémoire et le disque, zéro donnerait un serveur qui ne
 * démarre pas.
 */
const CHAMPS = [
  { clef: "memoryMb", label: "resizeMemory", aide: "resizeMemoryHint", zeroPermis: false },
  { clef: "diskMb", label: "resizeDisk", aide: "resizeDiskHint", zeroPermis: false },
  { clef: "cpuPct", label: "resizeCpu", aide: "resizeCpuHint", zeroPermis: true },
  { clef: "swapMb", label: "resizeSwap", aide: "resizeSwapHint", zeroPermis: true },
  { clef: "backups", label: "resizeBackups", aide: "resizeBackupsHint", zeroPermis: true },
  { clef: "databases", label: "resizeDatabases", aide: "resizeDatabasesHint", zeroPermis: true },
  { clef: "allocations", label: "resizePorts", aide: "resizePortsHint", zeroPermis: false },
] as const;

/**
 * Une quantité saisie est-elle exploitable ?
 *
 * Le champ vide et « 12a » donnent tous deux `NaN` ; sans ce contrôle, le
 * premier partirait comme `0` — une offre à zéro mégaoctet que l'API refuserait
 * après coup, en termes qui ne parlent pas de la frappe.
 */
function lisible(valeur: string, zeroPermis = false): boolean {
  const n = Number(valeur);
  if (valeur.trim() === "" || !Number.isInteger(n)) return false;
  // Le swap accepte -1 chez le daemon : « illimité ». Le refuser ici
  // interdirait un réglage que l'API accepte.
  return zeroPermis ? n >= -1 : n > 0;
}

const STATE_TONE: Record<string, "success" | "danger" | "info" | "neutral"> = {
  installing: "info",
  install_failed: "danger",
  restoring: "info",
  suspended: "neutral",
};

export function ResellerServers({ servers }: { servers: ResellerServer[] }) {
  const t = useTranslations("reseller");
  const tc = useTranslations("common");
  const ta = useTranslations("adminServers");
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Comptes dont le node n'a pas confirmé la fermeture des sessions à la
  // suspension : la suspension est faite, mais une session SFTP a pu rester.
  const [sessionsLeft, setSessionsLeft] = useState(0);
  const [toDelete, setToDelete] = useState<ResellerServer | null>(null);
  /*
   * Le serveur dont on change l'offre, et les deux quantités saisies.
   *
   * Gardées en texte et non en nombre : un champ vidé pour être retapé vaut
   * `NaN` si on le convertit à chaque frappe, et le bouton se grise sous les
   * doigts de celui qui est en train d'écrire.
   */
  const [toResize, setToResize] = useState<ResellerServer | null>(null);
  const [offre, setOffre] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const run = useCallback(
    (action: () => Promise<{ error: string | null; sessionsNotClosed?: number }>) =>
      startTransition(async () => {
        const result = await action();
        setSessionsLeft(result.sessionsNotClosed ?? 0);
        setError(result.error);
        if (!result.error) router.refresh();
      }),
    [router],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.ownerEmail.toLowerCase().includes(q) ||
        s.owner.toLowerCase().includes(q) ||
        s.node.toLowerCase().includes(q),
    );
  }, [servers, query]);

  const columns = useMemo<ColumnDef<ResellerServer, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: ta("columnServer"),
        cell: ({ row }) => (
          <div className="flex items-start gap-3">
            <StatusDot
              className="mt-1.5"
              tone={STATE_TONE[row.original.state ?? ""] ?? "neutral"}
              pulse={row.original.state === "installing"}
            />
            <div className="min-w-0">
              <p className="truncate font-semibold text-fg">{row.original.name}</p>
              <p className="gd-mono text-xs text-muted">{row.original.shortId}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: "owner",
        header: t("client"),
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate text-fg">{row.original.owner}</p>
            <p className="truncate text-xs text-muted">{row.original.ownerEmail}</p>
          </div>
        ),
      },
      {
        accessorKey: "node",
        header: ta("columnNode"),
        cell: ({ row }) => (
          <div>
            <p className="text-muted">{row.original.node}</p>
            <p className="text-xs text-faint">{row.original.egg}</p>
          </div>
        ),
      },
      {
        accessorKey: "memoryMb",
        header: t("memory"),
        cell: ({ row }) => (
          <div className="gd-mono text-muted">
            <p>{formatMb(row.original.memoryMb, 0)}</p>
            <p className="text-xs text-faint">{formatMb(row.original.diskMb, 0)}</p>
          </div>
        ),
      },
      {
        accessorKey: "state",
        header: ta("columnState"),
        cell: ({ row }) =>
          row.original.state ? (
            <Badge variant={STATE_TONE[row.original.state] ?? "neutral"}>
              {row.original.state}
            </Badge>
          ) : (
            // Aucun état de gestion ne veut pas dire « hors ligne » : l'état du
            // conteneur appartient à Wings, que cet écran n'interroge pas.
            <span className="text-faint">{tc("none")}</span>
          ),
      },
      {
        accessorKey: "createdAt",
        header: ta("columnCreated"),
        cell: ({ getValue }) => (
          <RelativeTime className="text-muted" value={getValue() as string} />
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const suspendu = row.original.state === "suspended";

          /*
           * Un serveur en installation ou en transfert n'est pas suspendable :
           * l'API refuserait, et proposer le bouton ferait apprendre la règle
           * en la heurtant — le défaut qu'on vient de corriger sur la console.
           */
          const occupe = row.original.state !== null && row.original.state !== "suspended";

          return (
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={pending || occupe}
                onClick={() => run(() => setResellerServerSuspended(row.original.id, !suspendu))}
              >
                {suspendu ? <Play /> : <Pause />}
                {suspendu ? t("resume") : t("suspend")}
              </Button>
              {/*
                La montée en gamme, qui n'existait nulle part : ni ici, ni
                dans l'administration, ni par l'API. Un client qui payait plus
                n'avait qu'un chemin — supprimer son serveur et le recréer.
              */}
              <Button
                variant="secondary"
                size="sm"
                disabled={pending || occupe}
                onClick={() => {
                  setOffre({
                    memoryMb: String(row.original.memoryMb),
                    diskMb: String(row.original.diskMb),
                    cpuPct: String(row.original.cpuPct),
                    swapMb: String(row.original.swapMb),
                    backups: String(row.original.backupLimit),
                    databases: String(row.original.databaseLimit),
                    allocations: String(row.original.allocationLimit),
                  });
                  setToResize(row.original);
                }}
              >
                <SlidersHorizontal />
              </Button>
              <Button
                variant="danger-ghost"
                size="sm"
                disabled={pending}
                onClick={() => setToDelete(row.original)}
              >
                <Trash2 />
              </Button>
            </div>
          );
        },
      },
    ],
    [t, tc, ta, pending, run],
  );

  return (
    <PageTemplate
      header={
        <PageHeader
          icon={<Server />}
          title={t("serversTitle")}
          subtitle={t("serversHint", { shown: filtered.length, total: servers.length })}
        />
      }
      toolbar={
        servers.length > 0 ? (
          <Input
            className="min-w-64 max-w-md"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            leadingIcon={<Search />}
          />
        ) : undefined
      }
    >
      {error ? (
        <AlertBanner variant="danger" title={tc("actionRefused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}
      {sessionsLeft > 0 ? (
        <AlertBanner
          variant="warning"
          title={ta("sessionsLeftTitle")}
          dismissible
          onDismiss={() => setSessionsLeft(0)}
        >
          {ta("sessionsLeftBody", { count: sessionsLeft })}
        </AlertBanner>
      ) : null}

      <DataTable
        columns={columns}
        data={filtered}
        getRowId={(row) => row.id}
        emptyState={
          <EmptyState
            icon={<Server />}
            title={servers.length === 0 ? t("noServers") : t("noMatch")}
            description={servers.length === 0 ? t("noServersHint") : tc("adjustFilters")}
          />
        }
      />
      <Dialog open={toResize !== null} onOpenChange={(o) => !o && setToResize(null)}>
        <DialogContent
          title={t("resizeTitle")}
          description={t("resizeHint", { name: toResize?.name ?? "" })}
          footer={
            <Button
              disabled={
                pending ||
                !CHAMPS.every((champ) => lisible(offre[champ.clef] ?? "", champ.zeroPermis))
              }
              onClick={() => {
                const cible = toResize;
                const valeurs = offre;
                setToResize(null);
                if (cible) {
                  run(() =>
                    setResellerServerLimits(
                      cible.id,
                      Object.fromEntries(
                        CHAMPS.map((champ) => [champ.clef, Number(valeurs[champ.clef])]),
                      ),
                    ),
                  );
                }
              }}
            >
              {tc("save")}
            </Button>
          }
        >
          {/*
            Deux colonnes dès qu'il y a la place : sept champs empilés font
            un dialogue qu'on parcourt au lieu de le lire.
          */}
          <div className="grid gap-4 sm:grid-cols-2">
            {CHAMPS.map((champ) => (
              <FormField key={champ.clef} label={t(champ.label)} description={t(champ.aide)}>
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={offre[champ.clef] ?? ""}
                    onChange={(e) =>
                      setOffre((prev) => ({ ...prev, [champ.clef]: e.target.value }))
                    }
                  />
                )}
              </FormField>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={t("deleteServerTitle")}
        description={t("deleteServerBody", { name: toDelete?.name ?? "" })}
        confirmLabel={tc("delete")}
        destructive
        onConfirm={() => {
          const cible = toDelete;
          setToDelete(null);
          if (cible) run(() => deleteResellerServer(cible.id));
        }}
      />
    </PageTemplate>
  );
}
