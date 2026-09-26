import { hashPassword } from "@gamedashboard/auth";
import type { SftpAuthRequest } from "@gamedashboard/contracts";
import type { Database } from "@gamedashboard/db";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SshKeyRepository } from "../auth/ssh-key.repository";
import { SftpAuthService, splitUsername, toWingsPermissions } from "./sftp-auth.service";

const NODE = "11111111-1111-1111-1111-111111111111";
const SERVER = "1a2b3c4d-0000-4000-8000-000000000000";
const OWNER = "44444444-4444-4444-4444-444444444444";
const PASSWORD = "cheval-agrafe-pile-correcte";
const USERNAME = "client@exemple.fr.1a2b3c4d";

/**
 * Base simulée : chaque lecture (`…limit(1)`) rend la réponse suivante de la
 * file, vide une fois la file épuisée. Le compteur dit si la base a été lue —
 * c'est-à-dire si un refus a été décidé avant ou après vérification.
 */
function sftp(reponses: unknown[][] = []) {
  let lectures = 0;
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      lectures += 1;
      return reponses.shift() ?? [];
    },
  };
  const db = { select: () => chain } as unknown as Database;
  const svc = new SftpAuthService(db, { markUsed: vi.fn() } as unknown as SshKeyRepository);
  return { svc, lectures: () => lectures };
}

const demande = (over: Partial<SftpAuthRequest> = {}): SftpAuthRequest => ({
  type: "password",
  username: USERNAME,
  password: PASSWORD,
  ip: "82.66.14.201",
  ...over,
});

describe("SFTP : état du serveur, limitation, mémoire", () => {
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Le propriétaire, avec le bon mot de passe, sur un serveur dans cet état. */
  function proprietaire(state: string | null) {
    return sftp([
      [{ id: SERVER, ownerId: OWNER, state }],
      [{ id: OWNER, email: "client@exemple.fr", passwordHash, suspendedAt: null }],
    ]);
  }

  it("ouvre au propriétaire un serveur ordinaire", async () => {
    // Témoin des deux suivants : sans lui, un refus pourrait venir d'une
    // doublure mal montée plutôt que de l'état du serveur.
    const { svc } = proprietaire(null);
    await expect(svc.authenticate(NODE, demande())).resolves.toMatchObject({
      server: SERVER,
      user: OWNER,
    });
  });

  // Tous les états fermés, `restoring` compris, que le panel pose désormais
  // pendant une restauration (NC-44).
  it.each(["installing", "restoring", "transferring", "install_failed", "suspended"])(
    "n'ouvre pas un serveur à l'état %s",
    async (state) => {
      const { svc } = proprietaire(state);
      await expect(svc.authenticate(NODE, demande())).resolves.toBeNull();
    },
  );

  /*
   * Mot de passe provisoire échu (revue du lot « reliquats-asvs », R3) : le
   * panel le refusait, le SFTP non.
   */
  it("refuse un mot de passe provisoire échu, pas un provisoire encore valable", async () => {
    const compte = (passwordExpiresAt: string) =>
      sftp([
        [{ id: SERVER, ownerId: OWNER, state: null }],
        [
          {
            id: OWNER,
            email: "client@exemple.fr",
            passwordHash,
            passwordExpiresAt,
            suspendedAt: null,
          },
        ],
      ]).svc;
    const hier = new Date(Date.now() - 60_000).toISOString();
    const demain = new Date(Date.now() + 3_600_000).toISOString();

    await expect(compte(hier).authenticate(NODE, demande())).resolves.toBeNull();
    await expect(compte(demain).authenticate(NODE, demande())).resolves.toMatchObject({
      user: OWNER,
    });
  });

  it("n'ouvre pas un serveur en cours de transfert", async () => {
    // Le daemon de départ archive les fichiers pendant ce temps : une
    // écriture SFTP s'y perdrait, ou arriverait à moitié sur l'autre node.
    const { svc } = proprietaire("transferring");
    await expect(svc.authenticate(NODE, demande())).resolves.toBeNull();
  });

  it("freine un compte éprouvé depuis de nombreuses adresses", async () => {
    /*
     * Les compteurs par adresse, et par couple adresse + compte, ne voient
     * rien d'une attaque répartie : trente adresses, un essai chacune, et
     * chacune reste sous ses seuils. Le compteur par nom d'utilisateur, lui,
     * les additionne.
     */
    const { svc, lectures } = sftp();
    for (let i = 0; i < 30; i += 1) {
      await svc.authenticate(NODE, demande({ ip: `203.0.113.${i}`, password: "faux" }));
    }

    const avant = lectures();
    await expect(svc.authenticate(NODE, demande({ ip: "198.51.100.7" }))).resolves.toBeNull();
    // Refus sans vérification : la base n'a pas été lue.
    expect(lectures()).toBe(avant);
  });

  it("oublie les compteurs dont la fenêtre est écoulée", async () => {
    // La `Map` ne se vidait qu'au passage d'une même adresse : des milliers
    // d'adresses de passage restaient en mémoire pour toujours.
    const { svc } = sftp();
    const failures = (svc as unknown as { failures: Map<string, unknown> }).failures;
    const debut = Date.now();
    const horloge = vi.spyOn(Date, "now").mockReturnValue(debut);

    // Identifiants malformés, tous différents : refusés sans lire la base, et
    // sans qu'aucun compteur n'atteigne son seuil.
    for (let i = 0; i < 500; i += 1) {
      await svc.authenticate(
        NODE,
        demande({ username: `balayage${i}`, ip: `10.0.${i >> 8}.${i}` }),
      );
    }
    expect(failures.size).toBeGreaterThan(500);

    horloge.mockReturnValue(debut + 11 * 60_000);
    await svc.authenticate(NODE, demande({ username: "balayage", ip: "10.9.9.9" }));

    // Ne restent que les compteurs de ce dernier essai.
    expect(failures.size).toBeLessThanOrEqual(3);
  });
});

describe("nom d'utilisateur SFTP", () => {
  it("coupe au dernier point, pas au premier", () => {
    // Une adresse e-mail contient des points : couper au premier donnerait
    // « matheo » pour « matheo.leduc@exemple.fr ».
    expect(splitUsername("matheo.leduc@exemple.fr.1a2b3c4d")).toEqual({
      label: "matheo.leduc@exemple.fr",
      shortId: "1a2b3c4d",
    });
  });

  it("accepte l'identifiant court quelle que soit sa casse", () => {
    expect(splitUsername("client@exemple.fr.1A2B3C4D")?.shortId).toBe("1a2b3c4d");
  });

  it("refuse ce qui n'a pas la forme imposée par le daemon", () => {
    // Pas de point, identifiant trop court, trop long, ou hors hexadécimal :
    // aucun ne peut désigner un serveur, et Wings les refuse déjà lui-même.
    for (const value of ["sanspoint", "a.1a2b3c", "a.1a2b3c4d5", "a.zzzzzzzz", ".1a2b3c4d"]) {
      expect(splitUsername(value), value).toBe(null);
    }
  });
});

describe("traduction des permissions pour Wings", () => {
  it("n'accorde rien sans le droit d'employer le SFTP", () => {
    /*
     * C'est ce droit qui ouvre la porte. Voir les fichiers dans le panel — qui
     * journalise chaque geste — et pouvoir les emporter par SFTP ne se donnent
     * pas au même monde.
     */
    expect(toWingsPermissions(["files.read", "files.write", "files.delete"])).toEqual([]);
  });

  it("donne les deux droits de lecture de Wings pour notre seul « files.read »", () => {
    // Wings distingue lister un dossier de lire un fichier ; le panel n'a qu'un
    // droit de lecture. N'en donner qu'un laisserait voir les noms sans jamais
    // pouvoir ouvrir quoi que ce soit.
    expect(toWingsPermissions(["files.sftp", "files.read"])).toEqual([
      "file.read",
      "file.read-content",
    ]);
  });

  it("traduit l'écriture en création et mise à jour", () => {
    expect(toWingsPermissions(["files.sftp", "files.write"])).toEqual([
      "file.create",
      "file.update",
    ]);
  });

  it("rend une liste vide quand le droit d'entrer est seul", () => {
    // Entrer sans pouvoir lire ni écrire n'est pas un accès : c'est une session
    // qui échoue à chaque commande. L'appelant traite donc ce cas en refus.
    expect(toWingsPermissions(["files.sftp"])).toEqual([]);
  });

  it("n'invente aucun droit à partir d'une permission voisine", () => {
    // `files.archive` autorise à fabriquer une archive depuis le panel, pas à
    // écrire des fichiers par SFTP.
    expect(toWingsPermissions(["files.sftp", "files.archive"])).toEqual([]);
  });
});
