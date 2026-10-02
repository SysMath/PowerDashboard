#!/usr/bin/env bash
# Construit l'application Android, dans le conteneur Linux de la CI
# (infra/ci/linux.sh, image Node épinglée), depuis la racine du dépôt.
#
#   bash apps/mobile/scripts/android.sh outils      JDK et outils du SDK Android
#   bash apps/mobile/scripts/android.sh construire  APK et AAB de publication, dans dist-mobile/
#
# `construire` signe avec la clé d'envoi des magasins quand
# ANDROID_KEYSTORE_BASE64 est donnée (mobile.yml, environnement `magasins`) :
# elle est écrite dans un dossier temporaire hors du dépôt, lue par Gradle
# (plugins/signature.ts) et effacée en sortie. Sans elle, la construction
# garde la clé de débogage et `construire` refuse de livrer.
set -euo pipefail

# Les outils en ligne de commande du SDK, épinglés par empreinte comme le CLI
# de CodeQL : le reste du SDK (plateforme, outils de compilation, NDK), Gradle
# le télécharge lui-même aux versions que demande React Native, depuis le
# dépôt de Google, licences acceptées ici.
OUTILS_VERSION=14742923
OUTILS_SHA256=04453066b540409d975c676d781da1477479dde3761310f1a7eb92a1dfb15af7
SDK=${ANDROID_HOME:-/opt/android-sdk}
export ANDROID_HOME=$SDK ANDROID_SDK_ROOT=$SDK
SORTIE=$PWD/dist-mobile

outils() {
  # JDK 17 de Debian, celui que demandent Gradle 9 et le greffon Android.
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends openjdk-17-jdk-headless unzip >/dev/null
  if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
    local tmp
    tmp=$(mktemp -d)
    curl -fsSL --retry 3 -o "$tmp/outils.zip" \
      "https://dl.google.com/android/repository/commandlinetools-linux-${OUTILS_VERSION}_latest.zip"
    echo "$OUTILS_SHA256  $tmp/outils.zip" | sha256sum -c -
    unzip -q "$tmp/outils.zip" -d "$tmp"
    mkdir -p "$SDK/cmdline-tools"
    mv "$tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
    rm -rf "$tmp"
  fi
  yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null || true
}

construire() {
  local version=${GAMEDASHBOARD_MOBILE_VERSION:?version absente}
  local cle
  cle=$(mktemp -d)
  trap 'rm -rf "$cle"' EXIT
  if [ -n "${ANDROID_KEYSTORE_BASE64:-}" ]; then
    (
      umask 077
      printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 -d >"$cle/magasin.jks"
    )
    export GD_ANDROID_KEYSTORE=$cle/magasin.jks
  fi
  unset ANDROID_KEYSTORE_BASE64

  (cd apps/mobile && CI=1 npx expo prebuild --platform android --clean --no-install)
  echo "sdk.dir=$SDK" >apps/mobile/android/local.properties
  (cd apps/mobile/android && ./gradlew --no-daemon assembleRelease bundleRelease)

  local apk=apps/mobile/android/app/build/outputs/apk/release/app-release.apk
  local aab=apps/mobile/android/app/build/outputs/bundle/release/app-release.aab
  mkdir -p "$SORTIE"
  cp "$apk" "$SORTIE/gamedashboard-mobile-$version.apk"
  cp "$aab" "$SORTIE/gamedashboard-mobile-$version.aab"

  # Ni un magasin ni un téléphone ne doivent recevoir un binaire signé par
  # la clé de débogage, connue de tous.
  local signature
  signature=$("$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)/apksigner" verify --print-certs \
    "$SORTIE/gamedashboard-mobile-$version.apk")
  if [ -z "${GD_ANDROID_KEYSTORE:-}" ] || grep -q "CN=Android Debug" <<<"$signature"; then
    echo "::error::APK signé par la clé de débogage : la clé d'envoi des magasins manque." >&2
    return 1
  fi
  grep "certificate SHA-256 digest" <<<"$signature"
}

commande=${1:?"usage : android.sh outils|construire"}
case $commande in
  outils | construire) "$commande" ;;
  *)
    echo "Commande inconnue : $commande" >&2
    exit 2
    ;;
esac
