/**
 * Le thème choisi, lu avant la première peinture.
 *
 * **Hors du module de la bascule, et c'est voulu.** `theme-toggle.tsx` est un
 * module client (`"use client"`) : tout ce qu'il exporte devient, vu du
 * serveur, une référence client — une fonction qui lève à l'appel — et non la
 * valeur. La route `/gd-theme.js` qui servait `THEME_INIT_SCRIPT` depuis ce
 * module rendait donc le texte de cette fonction, que le navigateur refusait
 * (« Function statements require a function name ») : le thème choisi n'était
 * jamais posé avant la peinture, et la page clignotait dans le thème du
 * système. Sans directive, ce module se lit pareil des deux côtés.
 */

/** Clé de stockage du thème choisi, partagée avec la bascule. */
export const THEME_STORAGE_KEY = "gd-theme";

/** Script à charger dans <head>, sans `defer` ni `async`, pour éviter le flash de thème. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})();`;
