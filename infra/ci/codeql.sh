#!/usr/bin/env bash
# Analyse CodeQL du dépôt, dans le conteneur Linux du job (codeql.yml).
#
#   bash infra/ci/codeql.sh <dossier de sortie>
#
# Écrit un fichier SARIF par langage (`javascript.sarif`, `actions.sarif`,
# `go.sarif`), que le workflow téléverse ensuite vers GitHub depuis le runner.
#
# L'agent de node (`agent/`, Go) se compile pour être analysé : la chaîne Go
# vient de l'image épinglée `IMAGE_GO`, recopiée dans `.chaine-go` par l'étape
# précédente du workflow, puis sortie du dépôt avant toute extraction.
#
# Pourquoi pas la « configuration par défaut » de GitHub : elle ne tourne que
# sur les runners de GitHub, jamais sur l'auto-hébergé. Et
# `github/codeql-action/init` tournerait directement sur le runner (Windows
# pour l'auto-hébergé), alors que tout job du projet travaille dans un
# conteneur Linux, le même sur chaque runner (docs/runner-auto-heberge.md). Le CLI tourne donc ici, et seul le
# téléversement (un appel d'API) reste sur le runner, où est le jeton.
set -euo pipefail

sortie=${1:?"usage : codeql.sh <dossier de sortie>"}
source infra/ci/outils.env

# Le cache `gd-ci-codeql` (monté sur /codeql par `linux.sh ouvrir --codeql`)
# ne garde que l'**archive**, jamais le CLI extrait : un fichier du cache
# n'est cru qu'après vérification de son empreinte, **à chaque job**. Un CLI
# gardé tout prêt ne serait vérifié qu'au téléchargement, et ce qu'un job
# précédent y aurait changé s'exécuterait ici sans que rien ne le voie.
archive=/codeql/codeql-bundle-$CODEQL_VERSION-linux64.tar.gz
verifier() { echo "$CODEQL_SHA256  $1" | sha256sum -c --quiet - >/dev/null 2>&1; }
if ! verifier "$archive"; then
  # Nom propre au conteneur, puis renommage : deux jobs simultanés ne
  # s'écrivent pas dessus, et un téléchargement coupé ne passe jamais pour
  # l'archive.
  partiel=$(mktemp /codeql/.telechargement-XXXXXX)
  curl -fsSL --retry 3 -o "$partiel" \
    "https://github.com/github/codeql-action/releases/download/codeql-bundle-v$CODEQL_VERSION/codeql-bundle-linux64.tar.gz"
  # Épinglée comme les images : une archive remplacée sous le même nom ne
  # s'exécute pas.
  if ! verifier "$partiel"; then
    rm -f "$partiel"
    echo "::error::L'archive de CodeQL $CODEQL_VERSION ne correspond pas à CODEQL_SHA256 (infra/ci/outils.env)." >&2
    exit 1
  fi
  mv -f "$partiel" "$archive"
  # Les autres versions ne servent plus, ni ce qu'un job coupé a laissé il y
  # a plus d'une heure (le téléchargement en cours d'un autre job reste).
  find /codeql -mindepth 1 -maxdepth 1 ! -name "${archive##*/}" ! -name '.telechargement-*' -exec rm -rf {} +
  find /codeql -mindepth 1 -maxdepth 1 -name '.telechargement-*' -mmin +60 -exec rm -rf {} +
fi
# Extraite dans le conteneur du job, qui disparaît avec lui, depuis une
# archive tout juste vérifiée.
outils=$(mktemp -d)
tar -xzf "$archive" -C "$outils"
codeql=$outils/codeql/codeql
"$codeql" version --format=terse

# La chaîne Go quitte le dépôt avant tout : laissée sous la racine, elle
# serait lue par l'extracteur JavaScript (misc/wasm) comme du code à nous.
[ -x .chaine-go/bin/go ] || {
  echo "::error::Chaîne Go absente (.chaine-go) : l'étape « Chaîne Go » de codeql.yml doit précéder l'analyse." >&2
  exit 1
}
chaine_go=$(mktemp -d)
mv .chaine-go "$chaine_go/go"

# TypeScript et JavaScript sans compilation (`--build-mode=none`), comme la
# configuration par défaut ; `actions` relit les workflows eux-mêmes
# (injection d'expressions, permissions, actions non épinglées).
# node_modules est écarté d'office par l'extracteur.
langages=(javascript-typescript actions)
base=$(mktemp -d)
"$codeql" database create "$base" --db-cluster --overwrite \
  --language="$(IFS=,; echo "${langages[*]}")" --build-mode=none \
  --source-root=. --threads=0

# Go se compile (`autobuild`, soit `go build ./...` dans `agent/`), avec la
# chaîne de l'image épinglée et hors de tout cache partagé ; sans l'état de
# Git, que la copie du dépôt n'a pas toujours pour son propriétaire.
PATH="$chaine_go/go/bin:$PATH" GOTOOLCHAIN=local GOFLAGS=-buildvcs=false \
  GOPATH="$chaine_go/gopath" GOCACHE="$chaine_go/cache" \
  "$codeql" database create "$base/go" --overwrite --language=go --build-mode=autobuild \
  --source-root=agent --threads=0

# Mémoire de l'évaluateur, en Mo. Sans `--ram`, le CLI part du tas par défaut
# de sa JVM (le quart de la mémoire vue), relevé à 2 Gio au plus bas : dans la
# machine virtuelle de Docker Desktop (8 Gio au plus sur le runner), cela
# faisait 1,1 Go de tas, dont 673 Mio pour les relations, partagés entre les
# 24 fils de `--threads=0`, et l'analyse JavaScript manquait de tas selon
# l'ordre où partaient les requêtes (« ran out of Java heap », code 99). Même
# règle que l'action officielle de CodeQL : la mémoire vue par le conteneur
# (limite du cgroup comprise), moins 1 Gio pour le système et 5 % de ce qui
# dépasse 8 Gio. `$1` : racine où lire /proc et /sys (vide ici).
memoire_evaluateur() {
  local total limite fichier
  total=$(awk '/^MemTotal:/ { print int($2 / 1024) }' "$1/proc/meminfo")
  for fichier in "$1/sys/fs/cgroup/memory.max" "$1/sys/fs/cgroup/memory/memory.limit_in_bytes"; do
    limite=$(cat "$fichier" 2>/dev/null) || continue
    if [[ $limite =~ ^[0-9]+$ ]] && ((limite / 1048576 < total)); then
      total=$((limite / 1048576))
    fi
  done
  echo $((total - 1024 - (total > 8192 ? (total - 8192) * 5 / 100 : 0)))
}
ram=$(memoire_evaluateur "")
echo "CodeQL : $ram Mo pour l'évaluateur, $(nproc) fils."

mkdir -p "$sortie"
for langage in "${langages[@]}" go; do
  # Le dossier de la base et la catégorie portent le nom court (javascript),
  # celui que GitHub affiche pour cette analyse.
  court=${langage%%-*}
  "$codeql" database analyze "$base/$court" --threads=0 --ram="$ram" \
    --format=sarif-latest --output="$sortie/$court.sarif" \
    --sarif-category="/language:$court"
done
rm -rf "$base" "$outils" "$chaine_go"
