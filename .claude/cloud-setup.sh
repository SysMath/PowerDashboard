#!/usr/bin/env bash
# Préparation d'une session Claude Code distante (environnement cloud).
#
# À coller dans le champ « Script de configuration » de l'environnement, ou à
# lancer tel quel depuis la racine du dépôt : `bash .claude/cloud-setup.sh`.
#
# Rejouable. Aucun secret ici : la seule clé posée est une clé d'essai, du
# même ordre que celle de la CI, qui ne déchiffre que ce que la session écrit.
set -euo pipefail

SUDO=$(command -v sudo >/dev/null 2>&1 && echo sudo || true)

# --- Node 24 (.nvmrc) ------------------------------------------------------
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$major" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
fi

# --- pnpm, à la version épinglée par package.json ---------------------------
$SUDO corepack enable
corepack prepare pnpm@11.27.1 --activate

# --- PostgreSQL, pour les tests d'intégration --------------------------------
# Sans base, ces tests se sautent proprement (HAS_DATABASE) : la session reste
# utilisable si l'installation échoue, elle vérifie seulement moins.
if ! command -v psql >/dev/null 2>&1; then
  $SUDO apt-get update -qq && $SUDO apt-get install -y -qq postgresql || true
fi
if command -v psql >/dev/null 2>&1; then
  $SUDO service postgresql start || true
  $SUDO -u postgres psql -tc "select 1 from pg_roles where rolname = 'gamedashboard'" | grep -q 1 \
    || $SUDO -u postgres psql -c "create role gamedashboard login createdb password 'gamedashboard'" || true
  $SUDO -u postgres psql -tc "select 1 from pg_database where datname = 'gamedashboard'" | grep -q 1 \
    || $SUDO -u postgres psql -c "create database gamedashboard owner gamedashboard" || true
fi

# --- cloudflared ---------------------------------------------------------------
# Installé pour disposer de l'outil, mais un tunnel ne s'établit PAS depuis une
# session distante : le conteneur ne laisse sortir que les ports TCP 80 et 443,
# quel que soit le niveau d'accès réseau de l'environnement, alors que
# cloudflared joint le bord de Cloudflare uniquement sur le port 7844 (QUIC en
# UDP comme HTTP/2 en TCP). `cloudflared tunnel --url …` affiche bien une
# adresse trycloudflare.com, puis échoue en boucle (« Allow outbound TCP on
# port 7844 ») : l'adresse ne mène nulle part. Pour un accès distant, lancer le
# tunnel depuis une machine dont le port 7844 sort, pas d'ici.
# Dernière version stable, paquet officiel publié sur GitHub. Facultatif : un
# échec (réseau filtré, architecture inconnue) n'empêche pas la session de
# démarrer.
if ! command -v cloudflared >/dev/null 2>&1; then
  arch=$(dpkg --print-architecture 2>/dev/null || echo amd64)
  deb=$(mktemp --suffix=.deb)
  if curl -fsSL -o "$deb" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch.deb"; then
    $SUDO dpkg -i "$deb" || true
  fi
  rm -f "$deb"
fi

# --- Dépendances du dépôt ----------------------------------------------------
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -f "$root/package.json" ]; then
  cd "$root"
  pnpm install --frozen-lockfile
  if command -v psql >/dev/null 2>&1; then
    DATABASE_URL=${DATABASE_URL:-postgres://gamedashboard:gamedashboard@127.0.0.1:5432/gamedashboard} \
      pnpm db:migrate || true
  fi
fi
