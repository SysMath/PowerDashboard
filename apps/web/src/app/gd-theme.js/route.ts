import { THEME_INIT_SCRIPT } from "@gamedashboard/ui";

/**
 * Le script qui pose le thème avant la première peinture, servi en fichier.
 *
 * **Pourquoi il n'est plus dans la page.** React 19 avertit dès qu'un
 * composant rend une balise `<script>` — « Encountered a script tag while
 * rendering React component » — et il le fait pour les trois formes : enfant
 * texte, `dangerouslySetInnerHTML`, et `next/script` en `beforeInteractive`,
 * qui finit par produire l'une des deux. L'avertissement est ici un faux
 * positif : le script s'exécute bien, au rendu serveur, et n'a rien à faire
 * lors d'une navigation côté client. Mais il s'écrit à chaque chargement, et
 * une console qui crie à tort finit par ne plus être lue.
 *
 * **Pourquoi une route et non un fichier dans `public/`.** Le script est une
 * constante du design system (`lib/theme-init.ts`, sans `"use client"` :
 * importée d'un module client, la route ne recevrait qu'une référence
 * client), avec la clé de stockage que lit aussi la bascule de thème. Le
 * recopier dans un fichier statique créerait deux vérités
 * qui divergeraient le jour où la clé change — et la divergence se
 * manifesterait par un thème qui ne tient pas entre deux chargements, sans
 * rien qui la désigne.
 *
 * La balise qui l'appelle est dans `<head>`, **sans `defer` ni `async`** :
 * c'est ce qui la fait s'exécuter avant la peinture. Le coût est une requête
 * supplémentaire au premier affichage ; ensuite le navigateur la garde.
 */
export function GET(): Response {
  return new Response(THEME_INIT_SCRIPT, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      // Une heure : le script ne change qu'avec une livraison, et le
      // redemander à chaque page retarderait la première peinture.
      "cache-control": "public, max-age=3600",
    },
  });
}
