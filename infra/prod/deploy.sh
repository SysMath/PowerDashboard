#!/usr/bin/env bash
#
# Déploiement du panel sur un serveur Linux (systemd, nginx, PostgreSQL).
#
# Le domaine se donne par `GD_DOMAIN=panel.mondomaine.fr`. Aux passages
# suivants, il est relu dans `PANEL_ORIGIN` du fichier api.env déjà écrit :
# une livraison n'a pas à le redemander. panel.conf est installé avec ce
# domaine à la place de `panel.example.fr`.
#
# Pour une première installation, `installer.sh` fait tout le chemin — paquets,
# certificat, premier administrateur — et appelle ce script. Voir
# docs/installation.md.
#
# Ce script s'exécute **sur le serveur**, en root. Il est idempotent : on peut
# le relancer à chaque livraison. Il ne crée un secret que s'il n'existe pas
# déjà — relancer un déploiement ne doit jamais rendre illisibles les secrets
# déjà chiffrés en base.
#
# La machine peut héberger d'autres services publics. Tout ce qui est fait ici
# est donc strictement additif : un utilisateur, une base, deux unités, un
# vhost. Rien d'existant n'est modifié.
set -euo pipefail

ROOT=/opt/gamedashboard
APP=$ROOT/app
ENVDIR=$ROOT/env
SRC=${1:-$APP}

WEB_PORT=3210
API_PORT=3211
EXEMPLE=panel.example.fr

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Le domaine : donné explicitement, sinon celui de l'installation existante.
# L'ancienne constante à éditer dans ce fichier était perdue au premier
# `rsync`, qui ramenait la version du dépôt.
DOMAIN=${GD_DOMAIN:-}
if [ -z "$DOMAIN" ] && [ -f "$ENVDIR/api.env" ]; then
  DOMAIN=$(sed -n 's#^PANEL_ORIGIN=https://##p' "$ENVDIR/api.env" | head -n 1)
fi
if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "$EXEMPLE" ]; then
  echo "Domaine inconnu. Relancer avec : GD_DOMAIN=panel.mondomaine.fr bash $0" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
say "Utilisateur et arborescence"
# ---------------------------------------------------------------------------
# Compte système sans shell : ce service n'a aucune raison d'avoir une session.
id -u gamedashboard >/dev/null 2>&1 || useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin gamedashboard
install -d -o gamedashboard -g gamedashboard -m 750 "$ROOT" "$APP" "$ROOT/var"
# L'arborescence des secrets est fermée : seul le service la lit.
install -d -o root -g gamedashboard -m 750 "$ENVDIR"

# ---------------------------------------------------------------------------
say "Base de données"
# ---------------------------------------------------------------------------
# PostgreSQL peut être partagé avec d'autres applications de la machine. On
# crée un rôle et une base dédiés, et on ne touche à rien d'autre.
DBPASS_FILE=$ENVDIR/.dbpass
if [ ! -f "$DBPASS_FILE" ]; then
  openssl rand -base64 33 | tr -d '\n/+=' > "$DBPASS_FILE"
  chmod 600 "$DBPASS_FILE"
fi
DBPASS=$(cat "$DBPASS_FILE")

# Le SQL passe par l'entrée standard, jamais en argument : un argument de
# commande est lisible dans `ps` par tout utilisateur de la machine le temps
# de l'exécution, et le mot de passe y figurerait.
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='gamedashboard'" | grep -q 1 \
  || printf "create role gamedashboard login password '%s'" "$DBPASS" | sudo -u postgres psql -q
# Le mot de passe est réaffirmé à chaque passage : il vient du fichier, qui
# fait autorité. Sinon un rôle créé à la main resterait avec un autre secret.
printf "alter role gamedashboard password '%s'" "$DBPASS" | sudo -u postgres psql -q

sudo -u postgres psql -tAc "select 1 from pg_database where datname='gamedashboard'" | grep -q 1 \
  || sudo -u postgres createdb -O gamedashboard gamedashboard

# ---------------------------------------------------------------------------
say "Environnement"
# ---------------------------------------------------------------------------
# La clé de chiffrement n'est générée qu'une fois. La régénérer rendrait
# illisibles tous les secrets déjà stockés — jetons de node, mots de passe de
# bases, secrets de webhooks : il faudrait tous les réémettre, pas seulement
# remettre une clé. Elle vit dans ce fichier, sans coffre : ADR 0007.
if [ ! -f "$ENVDIR/api.env" ]; then
  cat > "$ENVDIR/api.env" <<EOF
NODE_ENV=production
DATABASE_URL=postgres://gamedashboard:$DBPASS@127.0.0.1:5432/gamedashboard
APP_SECRET_KEY=$(openssl rand -base64 48)
PORT=$API_PORT
# N'écoute que la boucle locale : la machine a une adresse publique, et les
# routes d'administration ne doivent être joignables que par nginx.
HOST=127.0.0.1
PANEL_ORIGIN=https://$DOMAIN
# Catalogue CurseForge, lu par l'API et jamais par l'interface.
#
# Seule la clé se règle : les adresses et l'agent des deux catalogues sont des
# constantes des clients. Les déclarer ici laissait croire qu'on pouvait les
# changer — trois variables que rien ne lisait, dont l'une portait encore
# l'ancien nom du projet.
#
# Format bcrypt, avec des « $ » : entre guillemets simples, que systemd et
# bash lisent tous deux littéralement.
CURSEFORGE_API_KEY=
EOF
else
  # Le mot de passe de base peut changer ; la clé de chiffrement, jamais.
  sed -i "s#^DATABASE_URL=.*#DATABASE_URL=postgres://gamedashboard:$DBPASS@127.0.0.1:5432/gamedashboard#" "$ENVDIR/api.env"
fi

# L'interface n'a **ni DATABASE_URL ni APP_SECRET_KEY**. Elle lit tout par
# l'API, avec le cookie de l'utilisateur : une faille de rendu ne donne pas la
# base.
if [ ! -f "$ENVDIR/web.env" ]; then
  cat > "$ENVDIR/web.env" <<EOF
NODE_ENV=production
PORT=$WEB_PORT
HOSTNAME_BIND=127.0.0.1
API_URL=http://127.0.0.1:$API_PORT
PANEL_ORIGIN=https://$DOMAIN
EOF
fi
chown root:gamedashboard "$ENVDIR"/*.env
chmod 640 "$ENVDIR"/*.env

# ---------------------------------------------------------------------------
say "Dépendances et construction"
# ---------------------------------------------------------------------------
cd "$APP"
chown -R gamedashboard:gamedashboard "$APP"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# La version de pnpm vient de `packageManager` dans package.json, pas de celle
# installée sur la machine : deux résolutions différentes du même lockfile
# produiraient deux arbres différents.
#
# Il ne suffit pas d'appeler `corepack pnpm` : turbo relance `pnpm run build`
# dans chaque paquet, et trouve alors le pnpm global de la machine (12.3.4),
# qui refuse de tourner sur un projet épinglé en 11.27.1. On place donc en tête
# de PATH un relais qui renvoie vers la version épinglée — pour nous comme pour
# tout ce que nous lançons.
install -d -m 755 "$ROOT/bin"
cat > "$ROOT/bin/pnpm" <<'SHIM'
#!/bin/sh
exec corepack pnpm "$@"
SHIM
chmod 755 "$ROOT/bin/pnpm"
export PATH="$ROOT/bin:$PATH"

pnpm install --frozen-lockfile

# Une archive publiée (GitHub Releases) arrive avec l'interface construite
# par la CI : son fichier RELEASE porte l'identifiant de cette construction.
# S'il correspond à celui du dossier .next, reconstruire ne ferait que
# refaire la même chose, en demandant au serveur 1,5 Go de mémoire.
if [ -f RELEASE ] && [ -f apps/web/.next/BUILD_ID ] \
  && grep -qx "build_id=$(cat apps/web/.next/BUILD_ID)" RELEASE; then
  echo "  Interface déjà construite ($(sed -n 's/^version=//p' RELEASE)) : construction sautée"
else
  pnpm turbo run build --filter=@gamedashboard/web
fi

say "Migrations"
# Seule la variable dont la migration a besoin est passée : exporter tout
# api.env donnerait la clé de chiffrement à l'arbre de processus de pnpm, y
# compris aux scripts d'installation autorisés.
DATABASE_URL="$(grep '^DATABASE_URL=' "$ENVDIR/api.env" | cut -d= -f2-)" \
  pnpm --filter @gamedashboard/db db:migrate

chown -R gamedashboard:gamedashboard "$APP"

# ---------------------------------------------------------------------------
say "Unités systemd"
# ---------------------------------------------------------------------------
install -m 644 "$APP/infra/prod/gamedashboard-api.service" /etc/systemd/system/
install -m 644 "$APP/infra/prod/gamedashboard-web.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable gamedashboard-api.service gamedashboard-web.service
systemctl restart gamedashboard-api.service
systemctl restart gamedashboard-web.service

# ---------------------------------------------------------------------------
say "nginx"
# ---------------------------------------------------------------------------
# Réglages TLS inclus par le vhost. Posés seulement s'ils manquent : sur une
# machine partagée, d'autres vhosts incluent peut-être déjà ce fichier.
if [ ! -f /etc/nginx/snippets/tls/tls-intermediate.conf ]; then
  install -d -m 755 /etc/nginx/snippets/tls
  install -m 644 "$APP/infra/prod/tls-intermediate.conf" /etc/nginx/snippets/tls/
fi

# Le fichier du dépôt s'appelle panel.conf ; il est installé sous le nom du
# domaine. Le chercher sous ce nom dans le dépôt faisait échouer l'étape. Le
# nom d'exemple y est remplacé par le domaine réel, partout où il figure :
# server_name, journaux, chemin du certificat.
#
# `http2 on;` n'existe que depuis nginx 1.25.1. Debian 12 et Ubuntu 24.04
# livrent une version antérieure, qui refuse la directive : on y revient
# alors à l'ancienne écriture, `listen 443 ssl http2;`, que ces versions
# comprennent et que les suivantes acceptent encore.
VHOST=$(sed "s/$(printf '%s' "$EXEMPLE" | sed 's/\./\\./g')/$DOMAIN/g" "$APP/infra/prod/panel.conf")
NGINX_VERSION=$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')
if [ "$(printf '%s\n' 1.25.1 "$NGINX_VERSION" | sort -V | head -n 1)" != 1.25.1 ]; then
  VHOST=$(printf '%s\n' "$VHOST" | sed -e '/^[[:space:]]*http2 on;/d' \
    -e 's/^\([[:space:]]*listen .*443 ssl\);/\1 http2;/')
fi
printf '%s\n' "$VHOST" > "/etc/nginx/sites-available/$DOMAIN.conf"
chmod 644 "/etc/nginx/sites-available/$DOMAIN.conf"
ln -sfn "/etc/nginx/sites-available/$DOMAIN.conf" "/etc/nginx/sites-enabled/$DOMAIN.conf"
# `nginx -t` avant tout rechargement : si la machine sert d'autres sites, une
# configuration fautive les emporterait tous.
nginx -t
systemctl reload nginx

# ---------------------------------------------------------------------------
say "Contrôle de bon fonctionnement"
# ---------------------------------------------------------------------------
# Une construction qui réussit ne prouve pas qu'une page s'affiche. Un module
# d'actions serveur exportant autre chose qu'une fonction, par exemple, passe
# le build et fait échouer **le rendu de toutes les pages** : sans ce contrôle,
# c'est le premier visiteur qui l'apprend.
#
# On interroge les processus directement, sans passer par nginx : ce qu'on veut
# savoir ici, c'est si l'application rend, pas si le proxy relaie.
ECHECS=0

# On attend que les deux processus acceptent une connexion.
#
# `systemctl restart` rend la main dès que le processus est lancé, pas quand il
# écoute : sonder aussitôt renvoie « connexion refusée » et ferait échouer une
# livraison parfaitement saine. Trente secondes, puis on cesse d'attendre — un
# service qui n'écoute toujours pas ne le fera pas de lui-même.
attend() {
  local port=$1 nom=$2 i
  for i in $(seq 1 30); do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null; then
      printf '  %s écoute (après %ss)\n' "$nom" "$((i - 1))"
      return 0
    fi
    sleep 1
  done
  printf '  %s n écoute toujours pas après 30s\n' "$nom"
  ECHECS=$((ECHECS + 1))
}

attend $API_PORT API
attend $WEB_PORT interface
echo

# Un code HTTP ne suffit pas à juger une page : la frontière d'erreur de Next
# rend son écran « Une erreur est survenue » avec un **200**. C'est exactement
# le cas qui a motivé ce contrôle. On exige donc, pour chaque page, la présence
# de ce qu'elle doit montrer *et* l'absence de cet écran.
#
# Chaque page a droit à **une seconde chance**.
#
# Le premier rendu d'une page Next compile ses composants serveur à la demande,
# et la machine peut être partagée : un déploiement fait pendant que le build
# occupe encore les cœurs peut dépasser les vingt-cinq secondes sans que rien
# ne soit cassé. Le script déclarait alors la livraison mauvaise — ce qui est
# pire qu'un faux négatif, parce qu'on cherche ensuite une panne inexistante,
# ou pire, on revient en arrière sur une version saine.
#
# Une seule reprise, et une seule : ce qui échoue deux fois de suite n'est plus
# de la lenteur. Le résultat de la reprise est annoncé, pour qu'un premier
# essai raté reste visible plutôt que d'être effacé du rapport.
essai_page() {
  local chemin=$1 attendu_code=$2 marqueur=$3 corps=$4
  local code
  # Une connexion refusée fait sortir curl en erreur : sans ce repli, `set -e`
  # arrêterait le script au lieu de compter l'échec et de rendre son rapport.
  code=$(curl -s -o "$corps" -w '%{http_code}' --max-time 25 "http://127.0.0.1:$WEB_PORT$chemin") || code=000

  if [ "$code" != "$attendu_code" ]; then
    RAISON="$code  ATTENDU $attendu_code"
    return 1
  fi
  # Le texte **rendu** (entre balises), pas le texte seul : chaque page
  # embarque le catalogue de traductions, où la même phrase figure en JSON
  # (`"genericTitle":"Une erreur est survenue"`). Cherchée seule, elle
  # déclarait en échec toutes les pages, donc toute livraison.
  if grep -q ">Une erreur est survenue<" "$corps"; then
    RAISON="$code  FRONTIERE D ERREUR"
    return 1
  fi
  if [ -n "$marqueur" ] && ! grep -q "$marqueur" "$corps"; then
    RAISON="$code  CONTENU ABSENT ($marqueur)"
    return 1
  fi
  RAISON="$code"
  return 0
}

page() {
  local chemin=$1 attendu_code=$2 marqueur=$3
  local corps
  corps=$(mktemp)

  if essai_page "$chemin" "$attendu_code" "$marqueur" "$corps"; then
    printf '  %-34s %s\n' "$chemin" "$RAISON"
    rm -f "$corps"
    return
  fi

  local premiere="$RAISON"
  sleep 3
  if essai_page "$chemin" "$attendu_code" "$marqueur" "$corps"; then
    printf '  %-34s %s  (le premier essai avait donné : %s)\n' "$chemin" "$RAISON" "$premiere"
    rm -f "$corps"
    return
  fi

  printf '  %-34s %s  (deux essais)\n' "$chemin" "$RAISON"
  ECHECS=$((ECHECS + 1))
  rm -f "$corps"
}

point() {
  local chemin=$1 attendu=$2
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:$API_PORT$chemin") || code=000
  if [ "$code" = "$attendu" ]; then
    printf '  %-34s %s\n' "$chemin" "$code"
  else
    printf '  %-34s %s  ATTENDU %s\n' "$chemin" "$code" "$attendu"
    ECHECS=$((ECHECS + 1))
  fi
}

page /login     200 'name="email"'
page /status    200 'Statut de la plateforme'
# L'accueil du panel, sans session : il renvoie vers la connexion par une vraie
# redirection HTTP, et non par un 200 qui redirigerait une fois la page peinte.
# Un 200 ici signalerait que quelque chose rend à la place.
page /          307 ''

point /api/health                 200
point /api/v1/status              200
# Sans clé applicative, le refus est le résultat attendu.
point /api/v1/application/users   401

if [ "$ECHECS" -gt 0 ]; then
  echo
  echo "$ECHECS contrôle(s) en échec — la version déployée ne rend pas correctement."
  echo "Journaux : journalctl -u gamedashboard-web -n 50"
  exit 1
fi

say "Terminé"
systemctl --no-pager --lines=0 status gamedashboard-api gamedashboard-web | grep -E 'gamedashboard|Active'
