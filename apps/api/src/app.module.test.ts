import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "./app.module";
import { ServerTransferReaperService } from "./modules/admin/server-transfer-reaper.service";
import { RestoreReaperService } from "./modules/remote/restore-reaper.service";

/**
 * L'API entière se câble : chaque module trouve chacune de ses dépendances.
 *
 * Nest ne le vérifie qu'au démarrage, et les tests d'un service le
 * construisent à la main : un module qui oublie un fournisseur passait toute
 * la suite, puis empêchait l'API de démarrer. C'est arrivé avec le module de
 * mise à jour, dont les gardes d'administration attendaient
 * `PlatformSettingsService`.
 *
 * Aucune base n'est jointe : le client ne se connecte qu'à la première
 * requête, et `compile()` ne lance pas les tâches de fond.
 */
describe("AppModule", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://essai:essai@127.0.0.1:1/essai");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("résout toutes les dépendances de tous les modules", async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(module).toBeDefined();
    await module.close();
  });

  /*
   * Les balayages de fond ne sont appelés par personne : un balayage oublié
   * dans son module ne casse aucun câblage, il ne tourne simplement jamais.
   */
  it.each([
    ["restaurations sans nouvelles", RestoreReaperService],
    ["transferts perdus", ServerTransferReaperService],
  ])("enregistre le balayage des %s", async (_nom, balayage) => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(module.get(balayage, { strict: false })).toBeInstanceOf(balayage);
    await module.close();
  });
});
