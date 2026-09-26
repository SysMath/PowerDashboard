import { SFTP_INVALID_CREDENTIALS_STATUS, wingsWillRetry } from "@gamedashboard/contracts";
import { HttpException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ServerTransferService } from "../admin/server-transfer.service";
import type { NodeIdentity, NodeRepository } from "./node.repository";
import { parseWingsVersion, RemoteController } from "./remote.controller";
import type { RemoteActivityService } from "./remote-activity.service";
import type { RemoteBackupService } from "./remote-backup.service";
import type { RemoteServerService } from "./remote-server.service";
import type { SftpAuthService } from "./sftp-auth.service";

const NODE: NodeIdentity = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "RYZEN-09",
  tokenId: "node-abc",
  tokenSecret: "peu-importe",
  maintenanceMode: false,
};

const request = { node: NODE };

function controller(
  service: Partial<RemoteServerService> = {},
  nodes: Partial<NodeRepository> = {},
  backups: Partial<RemoteBackupService> | undefined = { complete: vi.fn(async () => {}) },
  activity: Partial<RemoteActivityService> = { record: vi.fn(async () => {}) },
  transfers: Partial<ServerTransferService> = {},
  sftp: Partial<SftpAuthService> = {},
) {
  return new RemoteController(
    {
      list: vi.fn(async () => ({
        data: [],
        meta: { current_page: 1, from: 0, last_page: 1, per_page: 50, to: 0, total: 0 },
      })),
      configuration: vi.fn(async () => null),
      installationScript: vi.fn(async () => null),
      markInstalled: vi.fn(async () => {}),
      resetTransientStates: vi.fn(async () => {}),
      ...service,
    } as unknown as RemoteServerService,
    { recordHeartbeat: vi.fn(async () => {}), ...nodes } as unknown as NodeRepository,
    (backups ?? { complete: vi.fn(async () => {}) }) as unknown as RemoteBackupService,
    activity as unknown as RemoteActivityService,
    {
      // Aucun transfert en cours par défaut : c'est l'état ordinaire, et le
      // supposer autrement ferait passer chaque lecture de configuration par
      // l'exception plutôt que par la règle.
      isTransferTarget: vi.fn(async () => false),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      ...transfers,
    } as unknown as ServerTransferService,
    {
      // Refus par défaut : c'est l'état d'un identifiant qu'on n'a pas prévu,
      // et le supposer autrement ferait passer les tests sur un accès accordé.
      authenticate: vi.fn(async () => null),
      ...sftp,
    } as unknown as SftpAuthService,
  );
}

describe("parseWingsVersion", () => {
  it("extrait la version de l'agent utilisateur du daemon", () => {
    expect(parseWingsVersion("Pterodactyl Wings/v1.11.13 (id:abcdef)")).toBe("1.11.13");
  });

  it("gère une version de développement", () => {
    expect(parseWingsVersion("Pterodactyl Wings/v1.12.0-rc.1 (id:x)")).toBe("1.12.0-rc.1");
  });

  it("accepte le double « v » que présentent les daemons récents", () => {
    // Relevé sur un vrai daemon 1.13.3 : Wings compose son agent avec un `v`
    // littéral suivi d'une chaîne de version qui porte déjà le sien. N'en
    // accepter qu'un affichait « version inconnue » sur un node en ligne.
    expect(parseWingsVersion("Pterodactyl Wings/vv1.13.3 (id:677e30ada48be10d)")).toBe("1.13.3");
  });

  it("renvoie null sur un agent inattendu plutôt qu'une valeur inventée", () => {
    // Une version fausse en base serait pire qu'une version absente : la
    // comparaison à la version supportée conclurait n'importe quoi.
    expect(parseWingsVersion("curl/8.5.0")).toBe(null);
    expect(parseWingsVersion(undefined)).toBe(null);
  });
});

describe("listServers", () => {
  it("horodate le contact du node au passage", async () => {
    const nodes = { recordHeartbeat: vi.fn(async () => {}) };
    await controller({}, nodes).listServers(request, "Pterodactyl Wings/v1.11.13 (id:x)");
    expect(nodes.recordHeartbeat).toHaveBeenCalledWith(NODE.id, "1.11.13");
  });

  it("n'écrase pas la version connue quand l'agent est illisible", async () => {
    const nodes = { recordHeartbeat: vi.fn(async () => {}) };
    await controller({}, nodes).listServers(request, "inconnu");
    expect(nodes.recordHeartbeat).toHaveBeenCalledWith(NODE.id, null);
  });

  it("emploie une pagination par défaut sur des paramètres absurdes", async () => {
    const list = vi.fn(async () => ({
      data: [],
      meta: { current_page: 1, from: 0, last_page: 1, per_page: 50, to: 0, total: 0 },
    }));
    await controller({ list } as Partial<RemoteServerService>).listServers(
      request,
      undefined,
      "-3",
      "0",
    );
    expect(list).toHaveBeenCalledWith(NODE.id, { page: 1, perPage: 50 });
  });

  it("traite la page 0 comme la première page", async () => {
    // Comportement observé sur le daemon réel : Wings demande `page=0` au
    // démarrage, puis poursuit de `current_page + 1` à `last_page`. Si la
    // page 0 était traitée comme distincte de la page 1, le décalage serait
    // négatif — PostgreSQL refuserait — et le daemon verrait ensuite deux fois
    // les mêmes serveurs.
    const list = vi.fn(async () => ({
      data: [],
      meta: { current_page: 1, from: 0, last_page: 1, per_page: 50, to: 0, total: 0 },
    }));
    await controller({ list } as Partial<RemoteServerService>).listServers(
      request,
      undefined,
      "0",
      "50",
    );
    expect(list).toHaveBeenCalledWith(NODE.id, { page: 1, perPage: 50 });
  });

  it("plafonne la taille de page", async () => {
    // Sans plafond, `per_page=1000000` faisait construire en une requête la
    // configuration complète de tous les serveurs du node. Le plafond reste
    // cohérent pour Wings : il pagine jusqu'à `last_page`, calculé avec la
    // taille retenue.
    const list = vi.fn(async () => ({
      data: [],
      meta: { current_page: 1, from: 0, last_page: 1, per_page: 500, to: 0, total: 0 },
    }));
    await controller({ list } as Partial<RemoteServerService>).listServers(
      request,
      undefined,
      "1",
      "1000000",
    );
    expect(list).toHaveBeenCalledWith(NODE.id, { page: 1, perPage: 500 });
  });

  it("lit le node depuis le jeton vérifié et non depuis la requête", async () => {
    // Aucune route ne prend d'identifiant de node en paramètre : sinon un node
    // compromis piloterait les serveurs d'un autre en changeant un champ.
    const list = vi.fn(async () => ({
      data: [],
      meta: { current_page: 1, from: 0, last_page: 1, per_page: 50, to: 0, total: 0 },
    }));
    await controller({ list } as Partial<RemoteServerService>).listServers(request, undefined);
    expect(list).toHaveBeenCalledWith(NODE.id, expect.anything());
  });
});

describe("serverConfiguration", () => {
  it("répond 404 pour un serveur inconnu, et non 500", async () => {
    // Wings ne réessaie pas sur un 4xx. Une 500 installerait une boucle de
    // tentatives pour un serveur qui n'existera jamais.
    const c = controller();
    await expect(c.serverConfiguration(request, "inconnu")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(wingsWillRetry(new NotFoundException().getStatus())).toBe(false);
  });
});

describe("installCompleted", () => {
  it("transmet un succès", async () => {
    const markInstalled = vi.fn(async () => {});
    await controller({ markInstalled } as Partial<RemoteServerService>).installCompleted(
      request,
      "s1",
      { successful: true, reinstall: false },
    );
    expect(markInstalled).toHaveBeenCalledWith(NODE.id, "s1", {
      successful: true,
      reinstall: false,
    });
  });

  it("conclut à l'échec sur un corps incomplet", async () => {
    // Conclure au succès marquerait installé un serveur qui ne l'est pas, et
    // le client se verrait proposer de le démarrer.
    const markInstalled = vi.fn(async () => {});
    await controller({ markInstalled } as Partial<RemoteServerService>).installCompleted(
      request,
      "s1",
      {},
    );
    expect(markInstalled).toHaveBeenCalledWith(NODE.id, "s1", {
      successful: false,
      reinstall: false,
    });
  });

  it("ne se laisse pas convaincre par une valeur approchante", async () => {
    const markInstalled = vi.fn(async () => {});
    await controller({ markInstalled } as Partial<RemoteServerService>).installCompleted(
      request,
      "s1",
      { successful: "true" },
    );
    expect(markInstalled).toHaveBeenCalledWith(NODE.id, "s1", {
      successful: false,
      reinstall: false,
    });
  });
});

describe("sftpAuth", () => {
  it("remet au daemon ce que le service a accordé", async () => {
    // Le contrôleur ne décide rien : il transmet le serveur, le compte et les
    // permissions tels quels. Les recomposer ici en ferait un second endroit
    // où le droit se décide.
    const granted = {
      server: "33333333-3333-3333-3333-333333333333",
      user: "44444444-4444-4444-4444-444444444444",
      permissions: ["file.read", "file.read-content"],
    };
    const authenticate = vi.fn(async () => granted);
    const c = controller({}, {}, undefined, undefined, {}, { authenticate });

    await expect(
      c.sftpAuth(request, {
        type: "public_key",
        username: "client@exemple.fr.1a2b3c4d",
        password: "ssh-ed25519 AAAA",
        ip: "10.0.0.1",
      }),
    ).resolves.toEqual(granted);

    // L'identité du node vient du jeton vérifié, jamais du corps de la requête.
    expect(authenticate).toHaveBeenCalledWith(NODE.id, expect.objectContaining({ ip: "10.0.0.1" }));
  });

  it("refuse quand le service ne reconnaît pas les identifiants", async () => {
    // Rien n'est accordé par défaut : un service qui ne dit pas oui dit non, et
    // c'est le contrôleur qui traduit ce silence en refus pour le daemon.
    const c = controller();
    await expect(
      c.sftpAuth(request, { type: "password", username: "u", password: "p", ip: "10.0.0.1" }),
    ).rejects.toMatchObject({ message: "Identifiants invalides." });
  });

  it("répond par un code que Wings interprète comme un refus", async () => {
    const c = controller();
    const thrown = await c
      .sftpAuth(request, { type: "password", username: "u", password: "p", ip: "1.1.1.1" })
      .then(() => null)
      .catch((e: unknown) => e as HttpException);
    expect(thrown).toBeInstanceOf(HttpException);
    const status = (thrown as HttpException).getStatus();
    expect(status).toBe(SFTP_INVALID_CREDENTIALS_STATUS);
    expect(wingsWillRetry(status)).toBe(false);
  });

  it("refuse une requête malformée sans la distinguer d'un mauvais mot de passe", async () => {
    // Toute distinction transformerait le SFTP en outil d'énumération.
    const c = controller();
    await expect(c.sftpAuth(request, { type: "keyboard-interactive" })).rejects.toMatchObject({
      message: "Identifiants invalides.",
    });
  });
});

describe("dépôt distant des sauvegardes", () => {
  it("refuse définitivement quand aucun stockage distant n'est configuré", async () => {
    /*
     * 404 et non 5xx, et la nuance décide du comportement du daemon : il
     * traite un 4xx comme définitif, là où un 5xx le ferait réessayer en
     * boucle pour une condition qui ne changera pas sans intervention
     * humaine. La sauvegarde échoue alors franchement, et son propriétaire en
     * est prévenu : l'adaptateur `s3` ne garde aucune copie locale.
     */
    const c = controller({}, {}, { openUpload: vi.fn(async () => null) });

    await expect(c.backupUploadUrls(request, "sauvegarde", "1024")).rejects.toThrow(
      NotFoundException,
    );
    expect(wingsWillRetry(new NotFoundException().getStatus())).toBe(false);
  });

  it("rend les adresses signées et la taille de partie", async () => {
    const openUpload = vi.fn(async () => ({ parts: ["https://exemple/1"], part_size: 42 }));
    const c = controller({}, {}, { openUpload, complete: vi.fn(async () => {}) });

    expect(await c.backupUploadUrls(request, "sauvegarde", "2048")).toEqual({
      parts: ["https://exemple/1"],
      part_size: 42,
    });
    // La taille vient du daemon, qui vient de peser l'archive : le panel n'a
    // pas le fichier et ne peut pas la deviner.
    expect(openUpload).toHaveBeenCalledWith(NODE.id, "sauvegarde", 2048);
  });
});

describe("journal d'activité poussé par le daemon", () => {
  it("borne le journal au node authentifié", async () => {
    // L'identifiant du node vient du jeton vérifié, jamais du corps : sans
    // cela, un node compromis écrirait dans le journal des serveurs des autres.
    const record = vi.fn(async () => {});
    await controller({}, {}, undefined, { record }).recordActivity(request, {
      data: [{ server: "s", event: "server:sftp.write" }],
    });

    expect(record).toHaveBeenCalledWith(NODE.id, [{ server: "s", event: "server:sftp.write" }]);
  });

  it("accepte un corps sans lot plutôt que d'échouer", async () => {
    // Refuser ferait réessayer le daemon indéfiniment pour des lignes de
    // journal qu'il finirait de toute façon par perdre.
    const record = vi.fn(async () => {});
    await controller({}, {}, undefined, { record }).recordActivity(request, {});

    expect(record).toHaveBeenCalledWith(NODE.id, []);
  });
});

describe("compte rendu de sauvegarde", () => {
  it("transmet l'identifiant du node issu du jeton, et non un identifiant de l'URL", async () => {
    const complete = vi.fn(async () => {});
    const c = controller({}, {}, { complete });

    await c.backupCompleted(request, "backup-1", { successful: true, size: 42 });

    expect(complete).toHaveBeenCalledWith(NODE.id, "backup-1", { successful: true, size: 42 });
  });

  it("supporte un corps absent plutôt que d'échouer sur une lecture de null", async () => {
    const complete = vi.fn(async () => {});
    const c = controller({}, {}, { complete });

    // Observé sur des daemons qui n'envoient rien : sans le repli, la route
    // répondrait 500 et Wings réessaierait indéfiniment le même compte rendu.
    await c.backupCompleted(request, "backup-1", undefined as never);

    expect(complete).toHaveBeenCalledWith(NODE.id, "backup-1", {});
  });

  it("transmet la fin d'une restauration, au nom du node authentifié", async () => {
    const restored = vi.fn(async () => {});
    const c = controller({}, {}, { restored });

    await c.backupRestored(request, "backup-1", { successful: true });
    await c.backupRestored(request, "backup-1", undefined as never);

    expect(restored).toHaveBeenNthCalledWith(1, NODE.id, "backup-1", true);
    // Un corps absent ne vaut pas une réussite.
    expect(restored).toHaveBeenNthCalledWith(2, NODE.id, "backup-1", false);
  });
});

/**
 * Le compte rendu de transfert décide d'un déménagement : c'est le seul
 * message du daemon qui change le node auquel un serveur appartient.
 */
describe("compte rendu de transfert", () => {
  it("n'accepte une réussite que du node vers lequel le transfert va", async () => {
    // Sans ce contrôle, n'importe quel node déclarerait réussi le transfert
    // d'un serveur qui ne le concerne pas — et se l'attribuerait.
    const complete = vi.fn(async () => {});
    const c = controller({}, {}, undefined, undefined, {
      isTransferTarget: vi.fn(async () => false),
      complete,
    });

    await expect(c.transferState(request, "serveur", "success")).rejects.toThrow(NotFoundException);
    expect(complete).not.toHaveBeenCalled();
  });

  it("bascule le serveur quand le node d'arrivée confirme", async () => {
    const complete = vi.fn(async () => {});
    const c = controller({}, {}, undefined, undefined, {
      isTransferTarget: vi.fn(async () => true),
      complete,
    });

    await c.transferState(request, "serveur", "success");
    expect(complete).toHaveBeenCalledWith("serveur");
  });

  it("accepte un échec des deux bouts", async () => {
    // Le départ n'a pas pu envoyer, ou l'arrivée n'a pas pu recevoir : dans les
    // deux cas le serveur reste où il est, et les deux daemons ont le droit de
    // le dire.
    const fail = vi.fn(async () => {});
    const c = controller({}, {}, undefined, undefined, {
      isTransferTarget: vi.fn(async () => false),
      fail,
    });

    await c.transferState(request, "serveur", "failure");
    expect(fail).toHaveBeenCalled();
  });

  it("sert la configuration au node d'arrivée pendant le transfert", async () => {
    // La base désigne encore le node de départ : sans cette exception, celui
    // d'arrivée obtiendrait un 404 et le transfert échouerait à la dernière
    // étape.
    const configurationForTransfer = vi.fn(async () => ({ uuid: "serveur" }));
    const configuration = vi.fn(async () => null);
    const c = controller(
      { configuration, configurationForTransfer } as never,
      {},
      undefined,
      undefined,
      {
        isTransferTarget: vi.fn(async () => true),
      },
    );

    await c.serverConfiguration(request, "serveur");
    expect(configurationForTransfer).toHaveBeenCalledWith("serveur");
    expect(configuration).not.toHaveBeenCalled();
  });
});
