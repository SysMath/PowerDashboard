/**
 * Point d'entrée **unique** de tous les workers de Monaco (NC-22).
 *
 * Un seul, et c'est contraint. Turbopack (Next 16) démarre chaque worker par
 * le même script d'amorce, en ne changeant que le fragment de l'URL
 * (`#params=…`, la liste des morceaux à charger). Chromium sert le second
 * worker depuis son cache mémoire, qui ignore le fragment, **avec l'URL du
 * premier** : le worker JSON démarrait avec les morceaux du worker de
 * l'éditeur, et chaque validation échouait (« Missing requestHandler … :
 * doValidation »). Constaté en navigateur, contre la version compilée. Avec
 * une seule entrée, tous les workers ont la même URL, et le quiproquo ne
 * change plus rien.
 *
 * Le service se choisit donc ici, au nom que `lib/monaco.ts` donne au worker,
 * et se charge **à la demande** : le compilateur TypeScript pèse sept
 * mégaoctets, et un éditeur de script shell n'a pas à les payer.
 *
 * Chaque module de worker de Monaco pose son propre `onmessage` en se
 * chargeant. Les messages arrivés avant — Monaco en envoie dès la création —
 * sont gardés, puis rendus dans l'ordre au gestionnaire en place : le premier
 * installe le suivant, qui reçoit le second.
 */

/*
 * Un `switch` et non une table indexée par le nom : `SERVICES[self.name]`
 * lisait, pour un nom comme `constructor`, une propriété héritée
 * d'`Object.prototype`, qu'on appelait ensuite (alerte CodeQL « appel de
 * méthode non validé »).
 */
function charger(nom: string): Promise<unknown> {
  switch (nom) {
    case "monaco-json":
      return import("monaco-editor/languages/features/json/json.worker");
    case "monaco-css":
      return import("monaco-editor/languages/features/css/css.worker");
    case "monaco-html":
      return import("monaco-editor/languages/features/html/html.worker");
    case "monaco-ts":
      return import("monaco-editor/languages/features/typescript/ts.worker");
    default:
      return import("monaco-editor/editor/editor.worker");
  }
}

const enAttente: MessageEvent[] = [];
self.onmessage = (message: MessageEvent) => {
  enAttente.push(message);
};

void charger(self.name).then(() => {
  for (const message of enAttente) self.onmessage?.call(self, message);
});
