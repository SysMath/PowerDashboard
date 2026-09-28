import { describe, expect, it } from "vitest";
import {
  backupDeletionBlocked,
  reinstallBlocked,
  SERVER_BLOCKS,
  SERVER_MANAGED_STATES,
  scheduleVerdict,
  serverBlock,
} from "./server";

/**
 * Tout état de gestion doit dire ce qu'il empêche.
 *
 * Un état absent de ce catalogue ne bloque **rien** : ni l'API qui refuse, ni
 * l'écran qui grise. Le défaut est silencieux dans les deux sens — aucune
 * erreur, aucun avertissement, juste un bouton qui obéit quand il ne devrait
 * pas.
 *
 * C'est arrivé : `transferring` n'y figurait pas. Un serveur en cours de
 * copie vers une autre machine acceptait d'être démarré, sur des fichiers que
 * l'autre côté écrivait encore.
 */
describe("blocages par état de gestion", () => {
  it.each(SERVER_MANAGED_STATES)("« %s » dit ce qu'il empêche", (state) => {
    const block = SERVER_BLOCKS[state];
    expect(block, `L'état « ${state} » n'a aucun blocage déclaré.`).toBeDefined();

    // Un libellé vide griserait les boutons sans dire pourquoi, ce qui est la
    // moitié du défaut qu'on corrige.
    expect(block.label.length).toBeGreaterThan(3);
    // Le corps doit expliquer, pas nommer : « installation » ne dit pas à
    // quelqu'un qui attend ce qu'il doit faire.
    expect(block.body.length).toBeGreaterThan(40);
  });

  it("ne bloque aucun état d'exécution", () => {
    // Ceux-là appartiennent au daemon et ne sont jamais écrits en base. Les
    // bloquer figerait l'interface sur un serveur parfaitement sain.
    for (const state of ["offline", "starting", "running", "stopping", "crash_loop"]) {
      expect(serverBlock(state), `« ${state} » ne devrait rien bloquer.`).toBeNull();
    }
  });

  it("traite l'absence d'état comme une absence de blocage", () => {
    // `null` est l'état de gestion normal d'un serveur en service : c'est le
    // cas le plus fréquent, et le confondre avec un état inconnu figerait tout.
    expect(serverBlock(null)).toBeNull();
    expect(serverBlock(undefined)).toBeNull();
    expect(serverBlock("")).toBeNull();
  });

  it("distingue ce qui se termine seul de ce qui demande un geste", () => {
    // « Patientez » devant un serveur suspendu ferait attendre indéfiniment
    // quelqu'un qui devait écrire à son hébergeur.
    expect(SERVER_BLOCKS.installing.transient).toBe(true);
    expect(SERVER_BLOCKS.restoring.transient).toBe(true);
    expect(SERVER_BLOCKS.transferring.transient).toBe(true);
    expect(SERVER_BLOCKS.suspended.transient).toBe(false);
    expect(SERVER_BLOCKS.install_failed.transient).toBe(false);
  });
});

/**
 * Ce qu'une tâche planifiée fait d'un serveur bloqué.
 *
 * Le minuteur n'avait aucune règle : il envoyait ses étapes quel que soit
 * l'état. Wings en rattrapait une partie, mais il fabrique volontiers une
 * sauvegarde d'un serveur suspendu — donc un serveur coupé par l'enveloppe de
 * son hébergeur remplissait encore le disque du node, chaque nuit.
 */
describe("verdict des tâches planifiées", () => {
  it("laisse passer ce qui n'est pas bloqué", () => {
    expect(scheduleVerdict(null)).toBe("run");
    expect(scheduleVerdict(undefined)).toBe("run");
    // Les états du conteneur ne sont pas des blocages : une tâche sur un
    // serveur à l'arrêt est exactement ce qu'on planifie le plus.
    expect(scheduleVerdict("offline")).toBe("run");
    expect(scheduleVerdict("running")).toBe("run");
  });

  it.each(SERVER_MANAGED_STATES)("« %s » n'exécute rien", (state) => {
    // L'essentiel du test : aucun état de gestion, présent ou ajouté demain,
    // ne doit rendre « run ». Un état nouveau qui laisserait tourner les
    // tâches serait un défaut silencieux — la sauvegarde partirait, et rien
    // ne le signalerait.
    expect(scheduleVerdict(state)).not.toBe("run");
  });

  it("reporte ce qui se termine seul, saute ce qui demande un geste", () => {
    // Quelques minutes d'attente : sauter ferait perdre la sauvegarde de la
    // nuit pour une gêne déjà finie au réveil.
    expect(scheduleVerdict("installing")).toBe("postpone");
    expect(scheduleVerdict("restoring")).toBe("postpone");
    expect(scheduleVerdict("transferring")).toBe("postpone");

    // Une suspension dure jusqu'à décision contraire. Réessayer toutes les
    // deux minutes n'y changerait rien.
    expect(scheduleVerdict("suspended")).toBe("skip");
    expect(scheduleVerdict("install_failed")).toBe("skip");
  });

  it("suit `transient` plutôt qu'une seconde liste", () => {
    // Le jour où un état change de nature, le verdict doit suivre tout seul :
    // deux listes finiraient par se contredire.
    for (const state of SERVER_MANAGED_STATES) {
      expect(scheduleVerdict(state)).toBe(SERVER_BLOCKS[state].transient ? "postpone" : "skip");
    }
  });
});

/**
 * La réinstallation, seule exception au blocage.
 *
 * Elle est le remède de `install_failed`, dont le message dit lui-même
 * « relancez une installation ». La refuser là renverrait le lecteur vers le
 * bouton qu'on vient de lui retirer, deux lignes sous le bandeau qui lui dit
 * d'appuyer dessus.
 */
describe("réinstallation", () => {
  it("reste ouverte sur une installation échouée", () => {
    expect(reinstallBlocked("install_failed")).toBe(false);
  });

  it("est fermée partout ailleurs où quelque chose bloque", () => {
    for (const state of SERVER_MANAGED_STATES) {
      if (state === "install_failed") continue;
      expect(reinstallBlocked(state), `L'état « ${state} »`).toBe(true);
    }
  });

  it("ne bloque rien sur un serveur qui va bien", () => {
    expect(reinstallBlocked(null)).toBe(false);
    expect(reinstallBlocked(undefined)).toBe(false);
    expect(reinstallBlocked("running")).toBe(false);
  });

  it("ne se confond pas avec le verdict des tâches planifiées", () => {
    // Les deux lisent le même catalogue et en tirent des décisions
    // différentes : une tâche planifiée ne réinstalle pas un serveur cassé,
    // et une réinstallation ne se reporte pas.
    expect(scheduleVerdict("install_failed")).toBe("skip");
    expect(reinstallBlocked("install_failed")).toBe(false);
  });
});

/**
 * Suppression d'une sauvegarde pendant une restauration (revue du lot
 * « reliquats-asvs », R1) : effacer l'archive rendue laissait le serveur en
 * `restoring` pour toujours. Ailleurs, supprimer reste permis pour libérer
 * de la place.
 */
describe("suppression d'une sauvegarde", () => {
  it("est refusée pendant une restauration, et seulement là", () => {
    expect(backupDeletionBlocked("restoring")).toBe(true);
    for (const state of SERVER_MANAGED_STATES) {
      if (state === "restoring") continue;
      expect(backupDeletionBlocked(state), `L'état « ${state} »`).toBe(false);
    }
    expect(backupDeletionBlocked(null)).toBe(false);
  });
});
