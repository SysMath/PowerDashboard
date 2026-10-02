import "server-only";
import QRCode from "qrcode";

/**
 * Dessine le QR code.
 *
 * Correction d'erreur au niveau « M » : un QR code lu à l'écran n'est ni sali
 * ni plié, et monter plus haut densifierait la grille sans rien gagner —
 * au risque qu'une caméra médiocre n'en vienne plus à bout.
 */
export async function renderQr(uri: string): Promise<string> {
  const svg = await QRCode.toString(uri, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    // Les couleurs sont figées en noir sur blanc : un QR code doit garder son
    // contraste, y compris quand la page est en thème sombre. La carte qui
    // l'entoure lui donne son fond blanc.
    color: { dark: "#000000", light: "#ffffff" },
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
