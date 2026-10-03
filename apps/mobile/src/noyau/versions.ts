/**
 * Compare deux versions `majeure.mineure.correctif`.
 *
 * Rend un nombre négatif si `a` précède `b`, positif s'il le suit, zéro sinon.
 * Un suffixe de préversion (`-rc.1`) est ignoré : le panel n'annonce que des
 * versions publiées.
 */
export function comparerVersions(a: string, b: string): number {
  const pa = morceaux(a);
  const pb = morceaux(b);
  for (let i = 0; i < 3; i += 1) {
    const ecart = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (ecart !== 0) return ecart;
  }
  return 0;
}

function morceaux(version: string): number[] {
  return (version.split("-")[0] ?? "")
    .split(".")
    .map((morceau) => Number.parseInt(morceau, 10))
    .map((nombre) => (Number.isFinite(nombre) ? nombre : 0));
}
