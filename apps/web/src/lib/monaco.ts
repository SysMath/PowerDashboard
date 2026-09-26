import { loader } from "@monaco-editor/react";

/**
 * Monaco servi par le panel, et non par un CDN (NC-22, ASVS 14.2.3).
 *
 * `@monaco-editor/react` charge par défaut Monaco depuis `cdn.jsdelivr.net`,
 * sans empreinte d'intégrité : une compromission du CDN, ou du paquet publié,
 * exécutait son script dans le panel, avec la session de l'administrateur qui
 * ouvre l'éditeur d'egg. Ici, Monaco vient de `node_modules`, compilé avec le
 * reste de l'interface : sa version est celle du lockfile, son contenu celui
 * que la CI a audité, et la politique de sécurité n'a plus à nommer de CDN.
 *
 * Chargé **à la demande**, par import dynamique : Monaco pèse plusieurs
 * mégaoctets, et seules les pages qui ouvrent un éditeur les paient — comme
 * avant, quand le CDN ne servait qu'à l'ouverture. Jamais au rendu serveur :
 * Monaco lit `window` et `document` dès son chargement.
 */

/** Les workers de Monaco, et l'étiquette par laquelle il demande chacun. */
export type MonacoWorker = "editor" | "json" | "css" | "html" | "ts";

/**
 * Quel worker pour quelle étiquette.
 *
 * Monaco demande ses workers par `MonacoEnvironment.getWorker`, **tous** :
 * dès que la fonction existe, il ne crée plus rien lui-même, et une étiquette
 * sans réponse ferait tomber le service de langage. Les étiquettes sont
 * celles de Monaco 0.57 (le `workerManager.js` de chaque service de
 * langage) ; ce qui n'en est pas une retombe sur le worker de l'éditeur.
 */
export function monacoWorkerFor(label: string): MonacoWorker {
  switch (label) {
    case "json":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "handlebars":
    case "razor":
      return "html";
    case "typescript":
    case "javascript":
      return "ts";
    default:
      return "editor";
  }
}

/*
 * Un `new Worker(new URL(…, import.meta.url))` écrit en entier : c'est cette
 * forme, et elle seule, que Turbopack compile en entrée de worker servie sous
 * `/_next/static` — donc sous `worker-src 'self'`. Le chemin que Monaco donne
 * à son worker d'éditeur, lui, serait copié tel quel, sans ses dépendances.
 *
 * Une seule entrée pour tous, qui choisit son service au nom du worker :
 * voir `monaco-workers/worker.ts` pour la raison.
 */
function monacoWorker(kind: MonacoWorker): Worker {
  return new Worker(new URL("./monaco-workers/worker.ts", import.meta.url), {
    type: "module",
    name: `monaco-${kind}`,
  });
}

let preparation: Promise<void> | null = null;

export function prepareMonaco(): Promise<void> {
  preparation ??= import("monaco-editor").then((monaco) => {
    globalThis.MonacoEnvironment = {
      getWorker: (_module, label) => monacoWorker(monacoWorkerFor(label)),
    };
    // Donné au chargeur, qui ne cherche alors plus rien sur le réseau.
    loader.config({ monaco });
  });
  return preparation;
}
