import type { ClientBackupList, ClientBackupView } from "@gamedashboard/contracts";

/** L'état d'une sauvegarde : le daemon n'a pas encore rendu compte, ou si. */
export type EtatSauvegarde = "en-cours" | "reussie" | "ratee";

export function etatSauvegarde(sauvegarde: ClientBackupView): EtatSauvegarde {
  if (sauvegarde.isSuccessful === null) return "en-cours";
  return sauvegarde.isSuccessful ? "reussie" : "ratee";
}

/** Seule une archive terminée et réussie se restaure (le panel refuse les autres). */
export function restaurable(sauvegarde: ClientBackupView): boolean {
  return etatSauvegarde(sauvegarde) === "reussie";
}

/** Le quota est atteint : le panel refuserait une sauvegarde de plus. */
export function quotaAtteint(liste: ClientBackupList): boolean {
  return liste.used >= liste.limit;
}

/** Une sauvegarde est en cours : la liste se relit plus souvent. */
export function enCours(liste: ClientBackupList | null): boolean {
  return liste?.items.some((sauvegarde) => sauvegarde.isSuccessful === null) ?? false;
}

/** Nom proposé pour une sauvegarde lancée du téléphone : `mobile-2026-10-02-1430`. */
export function nomParDefaut(date: Date): string {
  const deux = (n: number) => String(n).padStart(2, "0");
  return `mobile-${date.getFullYear()}-${deux(date.getMonth() + 1)}-${deux(date.getDate())}-${deux(date.getHours())}${deux(date.getMinutes())}`;
}

export type ActionSauvegarde = "restaurer" | "verrouiller" | "deverrouiller" | "supprimer";

/**
 * Le menu d'une sauvegarde. Rien tant que le daemon n'a pas rendu compte ;
 * une sauvegarde verrouillée ne se supprime pas (le panel le refuserait),
 * il faut d'abord la déverrouiller.
 */
export function actionsSauvegarde(sauvegarde: ClientBackupView): ActionSauvegarde[] {
  if (etatSauvegarde(sauvegarde) === "en-cours") return [];
  const actions: ActionSauvegarde[] = [];
  if (restaurable(sauvegarde)) actions.push("restaurer");
  actions.push(sauvegarde.isLocked ? "deverrouiller" : "verrouiller");
  if (!sauvegarde.isLocked) actions.push("supprimer");
  return actions;
}
