#!/usr/bin/env bash
# Un conteneur Linux par job de CI, piloté depuis le runner.
#
#   bash infra/ci/linux.sh ouvrir [--postgres] [--codeql]
#                                                crée le conteneur, y copie le dépôt
#   bash infra/ci/linux.sh lancer '<commande>'   exécute dans /w (bash -euo pipefail)
#   bash infra/ci/linux.sh outil <image> <args…> lance un outil sur le même /w
#   bash infra/ci/linux.sh psql '<sql>'          exécute sur la base du job
#   bash infra/ci/linux.sh rapatrier <chemin>…   recopie des fichiers vers le runner
#   bash infra/ci/linux.sh fermer                retire tout ce que le job a créé
#
# Pourquoi : le runner auto-hébergé est une machine Windows avec Docker.
# GitHub Actions n'y lance ni `services:` ni action conteneur (« Container
# operations are only supported on Linux runners »), et tout le projet —
# scripts bash, binaires natifs, captures de référence, archive de
# l'hébergement — suppose Linux. Les commandes tournent donc dans un conteneur
# Linux ; le runner ne fait que le piloter, depuis Git Bash. Sur un runner
# Linux (ubuntu-latest de GitHub), le même conteneur sert tel quel : même
# image, même verdict.
#
# Le dépôt est **copié** dans un volume, jamais monté depuis le disque de
# Windows : un montage NTFS rend `pnpm install` très lent, et ce qu'un
# conteneur y écrirait en root survivrait au job (docs/runner-auto-heberge.md).
# Le volume est partagé avec les outils (Trivy, Semgrep) et retiré à la fin.
set -euo pipefail

# Git Bash réécrit tout argument qui ressemble à un chemin Unix (« /w » devient
# « C:/Program Files/Git/w ») avant de le passer à docker.exe.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

# Épinglées par empreinte, comme les actions des workflows : une image qui
# change sous le même nom changerait le verdict sans que le dépôt bouge.
IMAGE_NODE=node@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 # 24.21.0-bookworm
IMAGE_POSTGRES=postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873 # 18.6-alpine

# Un nom par exécution, tentative et job : deux jobs sur la même machine ne se
# marchent pas dessus, et une relance ne reprend pas les restes de la première.
NOM=gd-ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${GITHUB_JOB:-job}
NOM=${NOM//[^a-zA-Z0-9_.-]/-}
VOLUME=$NOM-w
RESEAU=$NOM-reseau
BASE=$NOM-postgres
# Tout conteneur d'un job porte ces deux étiquettes : `gd-ci` pour le balayage
# des restes, `gd-ci.job` pour que `fermer` retire aussi ceux des outils
# (Trivy, Semgrep, ZAP), qu'un job annulé laisserait tourner malgré `--rm`.
ETIQUETTES=(--label gd-ci --label "gd-ci.job=$NOM")

# Variables transmises au conteneur, si elles sont posées sur le runner.
# GITHUB_REPOSITORY : le dépôt écrit dans le RELEASE de l'archive autonome
# (infra/release/autonome.mjs), où les hébergements cherchent leurs mises à jour.
TRANSMISES=(CI APP_SECRET_KEY E2E_EMAIL E2E_PASSWORD TURBO_TELEMETRY_DISABLED NEXT_TELEMETRY_DISABLED
  GAMEDASHBOARD_AUTONOME VERSION GITHUB_REPOSITORY)

ouvrir() {
  local postgres=0 codeql=0 option
  for option in "$@"; do
    case $option in
      --postgres) postgres=1 ;;
      --codeql) codeql=1 ;;
      *)
        echo "Option inconnue : $option" >&2
        return 2
        ;;
    esac
  done

  # Un refus d'accès au moteur est un réglage de la machine, pas du dépôt :
  # le dire tel quel plutôt que laisser « permission denied » sans suite.
  if ! docker info >/dev/null 2>&1; then
    echo "::error::Docker refuse l'accès à l'utilisateur du runner ($(whoami)). Sous Windows : l'ajouter au groupe local docker-users et vérifier que Docker Desktop tourne, puis redémarrer le service du runner (docs/runner-auto-heberge.md)." >&2
    docker info >&2 || true
    return 1
  fi

  balayer

  docker network create --label gd-ci "$RESEAU" >/dev/null
  docker volume create --label gd-ci "$VOLUME" >/dev/null

  local options=(--name "$NOM" "${ETIQUETTES[@]}" --network "$RESEAU" -w /w
    -v "$VOLUME:/w"
    # Caches d'une exécution à l'autre, sur la machine du runner : le store
    # pnpm et le navigateur de Playwright.
    -v gd-ci-pnpm-store:/pnpm-store
    # Le store sur ce volume, pas dans /w : pnpm le posait sinon dans
    # /w/.pnpm-store (autre système de fichiers que son dossier par défaut),
    # perdu à chaque job et lu par Trivy et Semgrep. Variable plutôt que la
    # configuration globale de pnpm, qui exige un dossier bin global dans le PATH.
    -e pnpm_config_store_dir=/pnpm-store
    -v gd-ci-playwright:/root/.cache/ms-playwright
    # Cache de build de Next (« No build cache found » sinon, et tout est
    # recompilé) : `next build` vide son dossier de sortie sauf `cache`, et
    # assembler.sh l'exclut de l'archive. Un volume pour chaque sortie, la
    # construction ordinaire et celle de l'archive autonome.
    -v gd-ci-next-cache:/w/apps/web/.next/cache
    -v gd-ci-next-autonome-cache:/w/apps/web/.next-autonome/cache
    -e TZ=UTC)
  local nom
  for nom in "${TRANSMISES[@]}"; do
    if [ -n "${!nom+x}" ]; then options+=(-e "$nom"); fi
  done

  # L'archive de CodeQL, pour le seul job de codeql.yml : les autres jobs
  # exécutent le code des dépendances (installation, tests), qui pourrait
  # sinon y laisser un fichier que le job CodeQL reprendrait. codeql.sh
  # revérifie de toute façon l'empreinte à chaque job.
  if [ "$codeql" = 1 ]; then options+=(-v gd-ci-codeql:/codeql); fi

  if [ "$postgres" = 1 ]; then
    docker run -d --name "$BASE" "${ETIQUETTES[@]}" --network "$RESEAU" \
      -e POSTGRES_USER=gamedashboard -e POSTGRES_PASSWORD=gamedashboard \
      -e POSTGRES_DB=gamedashboard -e TZ=UTC "$IMAGE_POSTGRES" >/dev/null
    options+=(-e "DATABASE_URL=postgres://gamedashboard:gamedashboard@$BASE:5432/gamedashboard")
  fi

  docker run -d "${options[@]}" "$IMAGE_NODE" sleep infinity >/dev/null
  # « ./. » : le **contenu** du dossier courant, et non le dossier lui-même.
  docker cp ./. "$NOM:/w"

  # pnpm à la version du dépôt (`packageManager`), posé par npm plutôt que par
  # corepack, dont les clés de signature retardent parfois sur pnpm.
  lancer "$(
    cat <<'PREPARER'
git config --global --add safe.directory /w
npm install -g --no-fund --no-audit --loglevel=error "$(node -p 'require("./package.json").packageManager')"
pnpm --version
PREPARER
  )"

  if [ "$postgres" = 1 ]; then
    local essai
    for essai in $(seq 30); do
      docker exec "$BASE" pg_isready -U gamedashboard >/dev/null 2>&1 && return 0
      sleep 2
    done
    echo "::error::PostgreSQL n'a pas démarré en une minute." >&2
    docker logs "$BASE" >&2 || true
    return 1
  fi
}

# Un job tué net (runner arrêté, machine éteinte, annulation) ne passe pas
# toujours par `fermer` : ses conteneurs s'accumuleraient et empêcheraient
# Docker Desktop de se mettre en veille (docs/runner-auto-heberge.md). Chaque
# job retire donc ce que les précédents ont laissé : tout conteneur arrêté
# tout de suite, et ceux qui tournent depuis plus d'une heure, le double du
# plus long délai d'un job (30 min). Le filtre par nom rattrape aussi les
# conteneurs créés avant les étiquettes.
balayer() {
  local limite id nom cree
  local filtre
  for filtre in label=gd-ci name=gd-ci-; do
    docker ps -aq --filter "$filtre" --filter status=exited --filter status=created \
      --filter status=dead | xargs -r docker rm -f >/dev/null 2>&1 || true
  done
  limite=$(($(date +%s) - 3600))
  for id in $(docker ps -aq --filter label=gd-ci) $(docker ps -aq --filter name=gd-ci-); do
    read -r nom cree < <(docker inspect -f '{{.Name}} {{.Created}}' "$id" 2>/dev/null) || continue
    if [ "$(date -d "$cree" +%s 2>/dev/null || echo "$limite")" -lt "$limite" ]; then
      docker rm -f "$id" >/dev/null 2>&1 || true
      # Le volume du dépôt porte le nom du conteneur ; celui d'un autre job
      # en cours, pas encore rattaché à son conteneur, n'est jamais visé.
      docker volume rm -f "${nom#/}-w" >/dev/null 2>&1 || true
    fi
  done
  docker network prune -f --filter label=gd-ci --filter until=1h >/dev/null 2>&1 || true
}

lancer() {
  local code=0
  docker exec -w /w "$NOM" bash -euo pipefail -c "$1" || code=$?
  # 137 = tué par SIGKILL : dans un conteneur, presque toujours le manque de
  # mémoire de la machine virtuelle de Docker Desktop.
  if [ "$code" = 137 ]; then
    echo "::error::Commande tuée (code 137), probablement faute de mémoire. Docker dispose de $(docker info --format '{{.MemTotal}}' 2>/dev/null | awk '{printf "%.1f Go", $1/1073741824}') ; en donner davantage à WSL (docs/runner-auto-heberge.md)." >&2
  fi
  return "$code"
}

outil() {
  local image=$1
  shift
  docker run --rm "${ETIQUETTES[@]}" --network "$RESEAU" -v "$VOLUME:/w" -w /w "$image" "$@"
}

psql() {
  docker exec "$BASE" psql -U gamedashboard -d gamedashboard -v ON_ERROR_STOP=1 -c "$1"
}

rapatrier() {
  local chemin
  for chemin in "$@"; do
    if docker exec "$NOM" test -d "/w/$chemin"; then
      mkdir -p "$chemin"
      docker cp "$NOM:/w/$chemin/." "$chemin/"
    elif docker exec "$NOM" test -e "/w/$chemin"; then
      mkdir -p "$(dirname "$chemin")"
      docker cp "$NOM:/w/$chemin" "$chemin"
    fi
  done
}

fermer() {
  docker rm -f "$NOM" "$BASE" >/dev/null 2>&1 || true
  docker ps -aq --filter "label=gd-ci.job=$NOM" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  docker network rm "$RESEAU" >/dev/null 2>&1 || true
}

commande=${1:?"usage : linux.sh ouvrir|lancer|outil|psql|rapatrier|fermer …"}
shift
case $commande in
  ouvrir | lancer | outil | psql | rapatrier | fermer) "$commande" "$@" ;;
  nom) echo "$NOM" ;;
  *)
    echo "Commande inconnue : $commande" >&2
    exit 2
    ;;
esac
