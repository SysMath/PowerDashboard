import type { ConsoleLevel } from "@gamedashboard/sdk/console-text";
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useTranslations } from "use-intl";
import { filtrerLignes, type LigneConsole } from "@/noyau/console";
import { ESPACE, MONO, RAYON, useCouleurs } from "@/theme/theme";
import { Bouton, Rangee } from "./base";

const NIVEAUX: ConsoleLevel[] = ["error", "warn", "info"];

/** La sortie de la console, filtrable par niveau et par recherche, comme sur le web. */
export function SortieConsole({ lignes }: { lignes: LigneConsole[] }) {
  const c = useCouleurs();
  const t = useTranslations("console");
  const [niveaux, setNiveaux] = useState<ConsoleLevel[]>([]);
  const [recherche, setRecherche] = useState("");
  const visibles = useMemo(
    () => filtrerLignes(lignes, { source: "all", levels: niveaux, query: recherche }),
    [lignes, niveaux, recherche],
  );
  const couleur = (ligne: LigneConsole) =>
    ligne.source === "system"
      ? c.ansiYellow
      : ligne.niveau === "error"
        ? c.ansiRed
        : ligne.niveau === "warn"
          ? c.ansiYellow
          : c.consoleFg;
  const basculer = (niveau: ConsoleLevel) =>
    setNiveaux((avant) =>
      avant.includes(niveau) ? avant.filter((n) => n !== niveau) : [...avant, niveau],
    );
  const libelles = { error: t("levelError"), warn: t("levelWarn"), info: t("levelInfo") };
  return (
    <View style={{ flex: 1, gap: ESPACE.s }}>
      <TextInput
        value={recherche}
        onChangeText={setRecherche}
        placeholder={t("search")}
        accessibilityLabel={t("search")}
        placeholderTextColor={c.textFaint}
        style={{
          color: c.text,
          backgroundColor: c.surface,
          borderRadius: RAYON.petit,
          padding: ESPACE.s,
        }}
      />
      <Rangee>
        {NIVEAUX.map((niveau) => (
          <Pressable
            key={niveau}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: niveaux.includes(niveau) }}
            onPress={() => basculer(niveau)}
            style={{
              paddingHorizontal: ESPACE.m,
              paddingVertical: ESPACE.xs,
              borderRadius: RAYON.petit,
              backgroundColor: niveaux.includes(niveau) ? c.accentSoft : c.surface2,
            }}
          >
            <Text style={{ color: c.text }}>{libelles[niveau]}</Text>
          </Pressable>
        ))}
      </Rangee>
      <FlatList
        style={{ flex: 1, backgroundColor: c.consoleBg, borderRadius: RAYON.petit }}
        contentContainerStyle={{ padding: ESPACE.s }}
        data={visibles}
        keyExtractor={(ligne) => String(ligne.id)}
        renderItem={({ item }) => (
          <Text selectable style={[MONO, { color: couleur(item), fontSize: 12 }]}>
            {item.texte}
          </Text>
        )}
        ListEmptyComponent={
          <Text style={{ color: c.consoleFg }}>
            {lignes.length === 0 ? t("waiting") : t("noMatch")}
          </Text>
        }
      />
    </View>
  );
}

/** La saisie d'une commande, envoyée par le panel (consignée au journal). */
export function SaisieConsole({
  onEnvoyer,
  inactif,
}: {
  onEnvoyer: (commande: string) => Promise<void>;
  inactif: boolean;
}) {
  const c = useCouleurs();
  const t = useTranslations("console");
  const [commande, setCommande] = useState("");
  const envoyer = () => {
    const texte = commande.trim();
    if (!texte) return;
    setCommande("");
    void onEnvoyer(texte);
  };
  return (
    <Rangee>
      <TextInput
        value={commande}
        onChangeText={setCommande}
        onSubmitEditing={envoyer}
        editable={!inactif}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={t("placeholder")}
        accessibilityLabel={t("command")}
        placeholderTextColor={c.textFaint}
        style={[
          MONO,
          {
            flex: 1,
            color: c.text,
            backgroundColor: c.surface,
            borderRadius: RAYON.petit,
            padding: ESPACE.s,
          },
        ]}
      />
      <Bouton titre={t("send")} onPress={envoyer} inactif={inactif} />
    </Rangee>
  );
}
