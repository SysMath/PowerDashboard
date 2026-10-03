import { TextInput } from "react-native";
import { useTranslations } from "use-intl";
import { ESPACE, MONO, RAYON, useCouleurs } from "@/theme/theme";

/**
 * L'éditeur du téléphone : un champ à chasse fixe, sans coloration ni
 * correcteur. Les retouches de configuration, pas le développement : Monaco
 * reste au navigateur (ADR 0010).
 */
export function ChampEditeur(props: { texte: string; onChange: (texte: string) => void }) {
  const c = useCouleurs();
  const t = useTranslations("fileEditor");
  return (
    <TextInput
      multiline
      value={props.texte}
      onChangeText={props.onChange}
      accessibilityLabel={t("title")}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      textAlignVertical="top"
      scrollEnabled
      style={[
        MONO,
        {
          flex: 1,
          color: c.text,
          backgroundColor: c.surface,
          borderColor: c.border,
          borderWidth: 1,
          borderRadius: RAYON.petit,
          padding: ESPACE.m,
          fontSize: 13,
        },
      ]}
    />
  );
}
