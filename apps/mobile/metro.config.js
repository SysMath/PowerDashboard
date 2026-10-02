// Configuration de Metro d'Expo, qui reconnaît le monorepo pnpm de lui-même :
// les paquets du dépôt (`@gamedashboard/*`) sont lus depuis leurs sources.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
