import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ESPACE, RAYON, useCouleurs } from "@/theme/theme";

/*
 * Atomes de l'application : mêmes rôles que ceux de `packages/ui`, en
 * composants React Native. Toutes les couleurs viennent de tokens.css.
 */

export function Ecran({ children, defile = true }: { children: ReactNode; defile?: boolean }) {
  const c = useCouleurs();
  const contenu = { padding: ESPACE.l, gap: ESPACE.m };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={["bottom", "left", "right"]}>
      {defile ? (
        <ScrollView contentContainerStyle={contenu}>{children}</ScrollView>
      ) : (
        <View style={[contenu, { flex: 1 }]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

type Ton = "normal" | "discret" | "titre" | "danger";

export function Texte({ children, ton = "normal" }: { children: ReactNode; ton?: Ton }) {
  const c = useCouleurs();
  const couleur = { normal: c.text, discret: c.textMuted, titre: c.text, danger: c.dangerInk }[ton];
  return (
    <Text
      style={{
        color: couleur,
        fontSize: ton === "titre" ? 22 : ton === "discret" ? 13 : 15,
        fontWeight: ton === "titre" ? "700" : "400",
      }}
    >
      {children}
    </Text>
  );
}

type Variante = "primaire" | "secondaire" | "danger";

export function Bouton(props: {
  titre: string;
  onPress: () => void;
  variante?: Variante;
  inactif?: boolean;
}) {
  const c = useCouleurs();
  const variante = props.variante ?? "primaire";
  const fond = { primaire: c.accent500, secondaire: c.surface2, danger: c.dangerSoft }[variante];
  const texte = { primaire: c.accentFg, secondaire: c.text, danger: c.dangerInk }[variante];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.inactif === true }}
      disabled={props.inactif}
      onPress={props.onPress}
      style={({ pressed }) => ({
        backgroundColor: fond,
        borderRadius: RAYON.petit,
        paddingVertical: ESPACE.m,
        paddingHorizontal: ESPACE.l,
        alignItems: "center",
        opacity: props.inactif ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ color: texte, fontWeight: "600", fontSize: 15 }}>{props.titre}</Text>
    </Pressable>
  );
}

export function Carte({
  children,
  onPress,
  onLongPress,
}: {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const c = useCouleurs();
  const style = {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: RAYON.normal,
    padding: ESPACE.l,
    gap: ESPACE.s,
  };
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} onLongPress={onLongPress} style={style}>
      {children}
    </Pressable>
  ) : (
    <View style={style}>{children}</View>
  );
}

export function Champ(props: TextInputProps & { libelle: string }) {
  const c = useCouleurs();
  return (
    <View style={{ gap: ESPACE.xs }}>
      <Texte ton="discret">{props.libelle}</Texte>
      <TextInput
        {...props}
        accessibilityLabel={props.libelle}
        placeholderTextColor={c.textFaint}
        style={{
          color: c.text,
          backgroundColor: c.surface,
          borderColor: c.borderStrong,
          borderWidth: 1,
          borderRadius: RAYON.petit,
          padding: ESPACE.m,
          fontSize: 16,
        }}
      />
    </View>
  );
}

type Niveau = "info" | "warning" | "danger" | "success";

export function Bandeau({
  titre,
  children,
  niveau = "info",
}: {
  titre: string;
  children?: ReactNode;
  niveau?: Niveau;
}) {
  const c = useCouleurs();
  const fond = {
    info: c.infoSoft,
    warning: c.warningSoft,
    danger: c.dangerSoft,
    success: c.successSoft,
  }[niveau];
  const encre = {
    info: c.infoInk,
    warning: c.warningInk,
    danger: c.dangerInk,
    success: c.successInk,
  }[niveau];
  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: fond,
        borderRadius: RAYON.petit,
        padding: ESPACE.m,
        gap: ESPACE.xs,
      }}
    >
      <Text style={{ color: encre, fontWeight: "700" }}>{titre}</Text>
      {children ? <Text style={{ color: encre }}>{children}</Text> : null}
    </View>
  );
}

/** Le point d'état d'un serveur : la couleur seule ne porte jamais le sens. */
export function Pastille({ niveau }: { niveau: Niveau | "neutre" }) {
  const c = useCouleurs();
  const couleur = niveau === "neutre" ? c.textFaint : c[niveau];
  return <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: couleur }} />;
}

export function Chargement() {
  const c = useCouleurs();
  return <ActivityIndicator color={c.accent500} style={{ padding: ESPACE.xl }} />;
}

export function Rangee({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: ESPACE.s, flexWrap: "wrap" }}>
      {children}
    </View>
  );
}
