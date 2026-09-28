#!/usr/bin/env bash
# Scan ZAP « baseline » du panel compilé (PLAN §5.4 et §12.2).
#
#   DATABASE_URL=… APP_SECRET_KEY=… bash infra/ci/zap-baseline.sh [dossier-du-rapport]
#   ZAP_CONTENEUR=<conteneur> bash infra/ci/zap-baseline.sh [dossier-du-rapport]
#
# Deux façons de tourner :
# - sur la machine (poste, runner Linux) : le panel démarre ici, et ZAP le
#   joint par le réseau de l'hôte ;
# - dans la CI (tout runner) : le panel démarre dans le conteneur Linux du
#   job (`ZAP_CONTENEUR`, voir infra/ci/linux.sh), qui porte déjà la base et
#   la clé, et ZAP partage son réseau.
#
# Le scan est **passif** : ZAP parcourt les pages et lit les réponses (en-têtes,
# CSP, cookies, formulaires) sans rien attaquer. C'est ce qui permet de le
# lancer sur la machine du runner sans risque pour ce qui l'entoure.
#
# Prérequis : `pnpm build` déjà fait, une base migrée, Docker.
#
# Sortie : 0 si aucune alerte hors des exceptions de zap-regles.tsv, non nul
# sinon. Le rapport HTML est copié dans le dossier donné (zap-rapport par
# défaut).
set -euo pipefail
# Git Bash réécrirait les chemins passés à docker.exe (voir infra/ci/linux.sh).
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

RACINE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RAPPORT=${1:-$RACINE/zap-rapport}
API_PORT=${ZAP_API_PORT:-3401}
WEB_PORT=${ZAP_WEB_PORT:-3400}
CIBLE="http://127.0.0.1:$WEB_PORT"
# Épinglée par empreinte, comme les actions des workflows : une image qui
# change sous le même nom changerait le verdict sans que le dépôt bouge.
# Quand ZAP se déclare trop ancien (alerte 10116), c'est cette empreinte qu'on
# remplace : `docker pull ghcr.io/zaproxy/zaproxy:stable`, puis RepoDigests.
IMAGE=ghcr.io/zaproxy/zaproxy@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef # 2.17.0

CONTENEUR=${ZAP_CONTENEUR:-}
if [ -z "$CONTENEUR" ]; then
  : "${DATABASE_URL:?DATABASE_URL manquante}"
  : "${APP_SECRET_KEY:?APP_SECRET_KEY manquante}"
fi
# Sans Docker, `docker run` échoue avec le code 1 — celui d'une alerte ZAP.
# Le script annonçait alors « alerte à corriger » pour un scan qui n'avait
# jamais eu lieu.
docker info >/dev/null 2>&1 || { echo "Docker ne répond pas : le scan ne peut pas tourner." >&2; exit 3; }

# Le dossier de travail de ZAP est préparé ici puis **copié** dans son
# conteneur, et le rapport recopié à la fin : aucun montage, donc aucun
# fichier écrit par ZAP (sous un autre utilisateur) ne reste dans _work. Les
# copies passent par une archive tar sur l'entrée et la sortie standard de
# `docker cp` : aucun chemin de Windows à traduire pour docker.exe, et le
# dossier arrive à l'utilisateur de ZAP (uid 1000) quels que soient les droits
# que Windows donne au dossier temporaire. L'image n'a pas de /zap/wrk.
TRAVAIL=$(mktemp -d)
mkdir "$TRAVAIL/wrk"
cp "$RACINE/infra/ci/zap-regles.tsv" "$TRAVAIL/wrk/regles.tsv"

ZAP=""
PIDS=()
arreter() {
  # Chaque service a son propre groupe (setsid) : pnpm lance node, et tuer
  # pnpm seul laisserait node tenir le port. Dans la CI, le conteneur du job
  # est retiré à la fin, services compris.
  for pid in "${PIDS[@]}"; do kill -- "-$pid" 2>/dev/null || true; done
  [ -n "$ZAP" ] && docker rm -f "$ZAP" >/dev/null 2>&1
  rm -rf "$TRAVAIL" 2>/dev/null || true
}
trap arreter EXIT

cd "$RACINE"
if [ -n "$CONTENEUR" ]; then
  docker exec -d -w /w "$CONTENEUR" bash -c \
    "PORT=$API_PORT HOST=127.0.0.1 PANEL_ORIGIN=$CIBLE NODE_ENV=production \
      pnpm --filter @gamedashboard/api start >/tmp/zap-api.log 2>&1"
  docker exec -d -w /w "$CONTENEUR" bash -c \
    "API_URL=http://127.0.0.1:$API_PORT PORT=$WEB_PORT NODE_ENV=production \
      pnpm --filter @gamedashboard/web start --port $WEB_PORT >/tmp/zap-web.log 2>&1"
  sonde() { docker exec "$CONTENEUR" curl "$@"; }
  journaux() { docker exec "$CONTENEUR" tail -n 40 /tmp/zap-api.log /tmp/zap-web.log; }
  RESEAU="container:$CONTENEUR"
else
  PORT=$API_PORT HOST=127.0.0.1 PANEL_ORIGIN=$CIBLE NODE_ENV=production \
    setsid pnpm --filter @gamedashboard/api start >"$TRAVAIL/api.log" 2>&1 &
  PIDS+=($!)
  API_URL="http://127.0.0.1:$API_PORT" PORT=$WEB_PORT NODE_ENV=production \
    setsid pnpm --filter @gamedashboard/web start --port "$WEB_PORT" >"$TRAVAIL/web.log" 2>&1 &
  PIDS+=($!)
  sonde() { curl "$@"; }
  journaux() { tail -n 40 "$TRAVAIL/api.log" "$TRAVAIL/web.log"; }
  RESEAU=host
fi

pret=0
for _ in $(seq 60); do
  if sonde -fsS -o /dev/null "$CIBLE/login" && sonde -sS -o /dev/null "http://127.0.0.1:$API_PORT/"; then
    pret=1
    break
  fi
  sleep 2
done
if [ "$pret" = 0 ]; then
  echo "Le panel n'a pas démarré en deux minutes." >&2
  journaux >&2 || true
  exit 1
fi

# ZAP joint le panel sur 127.0.0.1, comme un navigateur de la même machine :
# réseau de l'hôte, ou celui du conteneur du job. Sans -I, un avertissement
# non accepté rend un code non nul.
#
# `-z -silent` : sans lui, ZAP télécharge au démarrage les dernières règles
# « bêta » (-addonupdate), et le verdict changeait d'un jour à l'autre sans que
# le dépôt bouge — deux alertes apparues en CI, absentes du même scan en local.
# Les règles sont donc celles de l'image épinglée, ni plus ni moins ; on en
# gagne en changeant l'empreinte, pas au hasard d'une exécution.
code=0
# Dans la CI, étiqueté comme les conteneurs du job : `linux.sh fermer` le
# retire même si ce script est tué avant son `trap`.
ETIQUETTES=()
[ -n "$CONTENEUR" ] && ETIQUETTES=(--label gd-ci --label "gd-ci.job=$CONTENEUR")
ZAP=$(docker create "${ETIQUETTES[@]}" --network "$RESEAU" "$IMAGE" \
  zap-baseline.py -t "$CIBLE" -c regles.tsv -r rapport.html -J rapport.json -z -silent)
tar -C "$TRAVAIL" --owner=1000 --group=1000 --numeric-owner -cf - wrk | docker cp - "$ZAP:/zap"
docker start -a "$ZAP" || code=$?

mkdir -p "$RAPPORT"
for fichier in rapport.html rapport.json; do
  docker cp "$ZAP:/zap/wrk/$fichier" - 2>/dev/null | tar --no-same-owner -xf - -C "$RAPPORT" 2>/dev/null || true
done

case $code in
  0) echo "ZAP : aucune alerte hors des exceptions de infra/ci/zap-regles.tsv." ;;
  1 | 2) echo "ZAP : alerte à corriger ou à accepter dans infra/ci/zap-regles.tsv (rapport : $RAPPORT)." >&2 ;;
  *) echo "ZAP n'a pas pu mener le scan (code $code)." >&2 ;;
esac
exit "$code"
