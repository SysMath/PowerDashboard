import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_PRESENCE_ROUTES, APP_STAFF_ROUTES, appMayReach } from "@gamedashboard/contracts";
import { describe, expect, it } from "vitest";

/**
 * Les listes de l'application mobile désignent des routes qui existent.
 *
 * `APP_PRESENCE_ROUTES` est comparée au gabarit du routeur, à l'octet près :
 * une route renommée (`reinstall` devenu `settings/reinstall`) sortirait de la
 * liste sans bruit, et le geste lourd ne demanderait plus la confirmation de
 * présence. Le test relit les contrôleurs, comme celui du catalogue.
 */

const API = join(import.meta.dirname, "..", "..");

function routes(directory: string, found = new Set<string>()): Set<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) routes(full, found);
    else if (entry.name.endsWith(".controller.ts")) {
      const source = readFileSync(full, "utf8");
      const prefix = /@Controller\("([^"]*)"\)/.exec(source)?.[1] ?? "";
      for (const m of source.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:"([^"]*)")?\s*\)/g)) {
        const path = `/${[prefix, m[2] ?? ""].filter(Boolean).join("/")}`;
        found.add(`${m[1]?.toUpperCase()} ${path}`);
      }
    }
  }
  return found;
}

describe("routes de l'application mobile", () => {
  const reelles = routes(API);

  it("chaque geste lourd nommé existe, et l'application peut l'atteindre", () => {
    expect(APP_PRESENCE_ROUTES.length).toBeGreaterThan(0);
    for (const route of [...APP_PRESENCE_ROUTES, ...APP_STAFF_ROUTES]) {
      const cle = `${route.method} ${route.path}`;
      expect(reelles.has(cle), cle).toBe(true);
      expect(appMayReach(route.method, route.path), cle).toBe(true);
    }
  });

  it("les routes propres à l'application existent", () => {
    for (const cle of [
      "GET /api/v1/auth/me",
      "POST /api/v1/auth/app/challenge",
      "DELETE /api/v1/auth/app/device",
    ]) {
      expect(reelles.has(cle), cle).toBe(true);
      const [method = "", path = ""] = cle.split(" ");
      expect(appMayReach(method, path), cle).toBe(true);
    }
  });

  it("aucune route d'administration ni de revendeur n'est ouverte hors de APP_STAFF_ROUTES", () => {
    const ouvertes = [...reelles].filter((cle) => {
      const [method = "", path = ""] = cle.split(" ");
      return /^\/api\/v1\/(admin|reseller)\//.test(path) && appMayReach(method, path);
    });
    expect(ouvertes).toEqual(APP_STAFF_ROUTES.map((r) => `${r.method} ${r.path}`));
  });
});
