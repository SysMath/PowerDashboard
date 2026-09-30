import { describe, expect, it } from "vitest";
import {
  buildWingsNodeConfiguration,
  WINGS_CONFIGURE_ACCEPT,
  WINGS_CONFIGURE_PREFIX,
  wingsConfigureCommand,
  wingsNodeConfigurationPath,
} from "./wings-node-config";

const NODE = {
  id: "8f1c7c66-3a2d-4a51-9e0a-5a4a1a2b3c4d",
  fqdn: "node01.gamedashboard.fr",
  scheme: "https",
  daemonPort: 8080,
  daemonSftpPort: 2022,
  tokenId: "abcdefghijklmnop",
  token: "un-jeton-de-daemon",
  panelOrigin: "https://panel.example.fr",
};

describe("adresse imposée par Wings", () => {
  it("n'a pas de version dans le chemin", () => {
    // `wings configure` construit « api/application/nodes/{id}/configuration ».
    // Un « v1 » glissé ici rendrait la commande muette sans qu'aucune de nos
    // routes ne change de comportement.
    expect(WINGS_CONFIGURE_PREFIX).toBe("/api/application");
    expect(WINGS_CONFIGURE_PREFIX).not.toContain("v1");
  });

  it("n'est pas le préfixe de notre API applicative", () => {
    expect(WINGS_CONFIGURE_PREFIX).not.toBe("/api/v1/application");
  });

  it("compose le chemin complet d'un node", () => {
    expect(wingsNodeConfigurationPath(NODE.id)).toBe(
      `/api/application/nodes/${NODE.id}/configuration`,
    );
  });

  it("annonce l'entête que Wings envoie", () => {
    expect(WINGS_CONFIGURE_ACCEPT).toBe("application/vnd.pterodactyl.v1+json");
  });
});

describe("nom de l'application", () => {
  it("porte la marque de la plateforme", () => {
    // Wings en nomme ses conteneurs et ses journaux : un exploitant qui lit
    // `docker ps` doit y reconnaître le panel qui pilote sa machine.
    expect(buildWingsNodeConfiguration({ ...NODE, appName: "Revendeur" }).app_name).toBe(
      "Revendeur",
    );
  });

  it("retombe sur le nom du produit plutôt que sur celui de Pterodactyl", () => {
    // La valeur par défaut de Wings est « Pterodactyl » : ne rien envoyer la
    // laisserait en place sur toutes les machines du parc.
    expect(buildWingsNodeConfiguration(NODE).app_name).toBe("GameDashboard");
    expect(buildWingsNodeConfiguration({ ...NODE, appName: "  " }).app_name).toBe("GameDashboard");
  });
});

describe("configuration rendue au daemon", () => {
  it("rend le jeton et son identifiant sous les noms attendus", () => {
    const config = buildWingsNodeConfiguration(NODE);
    // `token_id` et `token`, pas `tokenId` : ce sont les balises JSON de la
    // structure Go, et Wings ne reconnaît rien d'autre.
    expect(config.token_id).toBe(NODE.tokenId);
    expect(config.token).toBe(NODE.token);
    expect(config.uuid).toBe(NODE.id);
  });

  it("déduit les chemins de certificat du nom de domaine en HTTPS", () => {
    const config = buildWingsNodeConfiguration(NODE);
    expect(config.api.ssl.enabled).toBe(true);
    expect(config.api.ssl.cert).toBe("/etc/letsencrypt/live/node01.gamedashboard.fr/fullchain.pem");
    expect(config.api.ssl.key).toBe("/etc/letsencrypt/live/node01.gamedashboard.fr/privkey.pem");
  });

  it("n'invente pas de certificat en HTTP", () => {
    // Un chemin de certificat posé sur un node en clair désignerait un fichier
    // absent, et le daemon refuserait de démarrer pour une raison qui n'a
    // aucun rapport avec ce que l'exploitant a demandé.
    const config = buildWingsNodeConfiguration({ ...NODE, scheme: "http" });
    expect(config.api.ssl.enabled).toBe(false);
    expect(config.api.ssl.cert).toBe("");
    expect(config.api.ssl.key).toBe("");
  });

  it("reprend les ports déclarés sur le node", () => {
    const config = buildWingsNodeConfiguration({
      ...NODE,
      daemonPort: 8443,
      daemonSftpPort: 2222,
    });
    expect(config.api.port).toBe(8443);
    expect(config.system.sftp.bind_port).toBe(2222);
  });

  it("laisse le daemon écouter sur toutes les interfaces", () => {
    // C'est le pare-feu de la machine qui restreint. Deviner une adresse de
    // liaison depuis le panel produirait un daemon injoignable.
    expect(buildWingsNodeConfiguration(NODE).api.host).toBe("0.0.0.0");
  });

  it("n'impose pas le mode verbeux", () => {
    // Une décision d'exploitation, prise sur la machine : l'écraser à chaque
    // reconfiguration couperait un diagnostic en cours.
    expect(buildWingsNodeConfiguration(NODE).debug).toBe(false);
  });
});

describe("ligne de commande", () => {
  it("passe toujours le node en option", () => {
    // L'invite interactive de Wings n'accepte qu'un entier décimal, héritage
    // des identifiants numériques de Pterodactyl. Nos nodes sont des UUID :
    // sans `--node`, la commande est inutilisable.
    expect(wingsConfigureCommand({ panelOrigin: NODE.panelOrigin, nodeId: NODE.id })).toContain(
      `--node ${NODE.id}`,
    );
  });

  it("retire la barre oblique finale de l'origine", () => {
    // Wings recolle le chemin derrière : une barre en trop donnerait
    // « //api/application/… », que le panel ne reconnaît pas.
    const command = wingsConfigureCommand({
      panelOrigin: "https://panel.example.fr/",
      nodeId: NODE.id,
    });
    expect(command).toContain("--panel-url https://panel.example.fr ");
  });

  it("retire les barres finales en temps linéaire", () => {
    const debut = performance.now();
    wingsConfigureCommand({ panelOrigin: `https://p${"/".repeat(100_000)}x`, nodeId: NODE.id });
    expect(performance.now() - debut).toBeLessThan(200);
  });

  it("nomme la clé applicative plutôt que de laisser un trou", () => {
    const command = wingsConfigureCommand({ panelOrigin: NODE.panelOrigin, nodeId: NODE.id });
    expect(command).toContain("--token <clé applicative>");
  });
});
