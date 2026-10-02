import { type ReactNode, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";
import { ESPACE, RAYON, useCouleurs } from "@/theme/theme";
import { Bandeau, Bouton, Champ, Texte } from "./base";

/*
 * Feuilles qui montent du bas de l'écran. `Alert` ne convient pas : Android
 * n'y affiche que trois boutons, et iOS seul y accepte une saisie.
 */

function Feuille({
  ouverte,
  onFermer,
  onDisparue,
  children,
}: {
  ouverte: boolean;
  onFermer: () => void;
  onDisparue?: () => void;
  children: ReactNode;
}) {
  const c = useCouleurs();
  const tc = useTranslations("mobile.commun");
  return (
    <Modal
      visible={ouverte}
      transparent
      animationType="slide"
      onRequestClose={onFermer}
      onDismiss={onDisparue}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={{ flex: 1 }} onPress={onFermer} accessibilityLabel={tc("annuler")}>
          <View style={{ flex: 1, backgroundColor: c.bg, opacity: 0.7 }} />
        </Pressable>
        <SafeAreaView
          edges={["bottom"]}
          style={{
            backgroundColor: c.surface,
            borderTopLeftRadius: RAYON.normal,
            borderTopRightRadius: RAYON.normal,
            padding: ESPACE.l,
            gap: ESPACE.s,
          }}
        >
          {children}
          <Bouton titre={tc("annuler")} variante="secondaire" onPress={onFermer} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export interface Choix {
  titre: string;
  danger?: boolean;
  onPress: () => void;
}

/**
 * Un menu de gestes ; fermé quand `titre` vaut `null`. Sous iOS, le geste
 * choisi attend que la feuille ait disparu : une alerte ou une autre feuille
 * ouverte pendant sa sortie ne s'afficherait pas.
 */
export function Menu(props: { titre: string | null; choix: Choix[]; onFermer: () => void }) {
  const [suite, setSuite] = useState<(() => void) | null>(null);
  const choisir = (choix: Choix) => {
    if (Platform.OS === "ios") setSuite(() => choix.onPress);
    else choix.onPress();
    props.onFermer();
  };
  return (
    <Feuille
      ouverte={props.titre !== null}
      onFermer={props.onFermer}
      onDisparue={() => {
        suite?.();
        setSuite(null);
      }}
    >
      <Texte ton="discret">{props.titre}</Texte>
      {props.choix.map((choix) => (
        <Bouton
          key={choix.titre}
          titre={choix.titre}
          variante={choix.danger ? "danger" : "secondaire"}
          onPress={() => choisir(choix)}
        />
      ))}
    </Feuille>
  );
}

/**
 * Un nom à saisir. `refus` juge la saisie avant tout envoi ; `valider` rend
 * le refus du panel à afficher, ou `null` quand c'est fait, et la feuille se
 * ferme. Fermée quand `titre` vaut `null`. Avec `nouveau`, la valeur de
 * départ ne s'envoie pas (un renommage qui garde le nom), sans être pour
 * autant une faute à dire en rouge.
 */
type ProprietesSaisie = {
  titre: string | null;
  libelle: string;
  initiale: string;
  aide?: string;
  action: string;
  nouveau?: boolean;
  refus: (valeur: string) => string | null;
  valider: (valeur: string) => Promise<string | null>;
  onFermer: () => void;
};

export function Saisie(props: ProprietesSaisie) {
  // Le contenu ne vit que feuille ouverte : chaque ouverture repart de `initiale`.
  return (
    <Feuille ouverte={props.titre !== null} onFermer={props.onFermer}>
      {props.titre !== null ? <ContenuSaisie {...props} /> : null}
    </Feuille>
  );
}

function ContenuSaisie(props: ProprietesSaisie) {
  const [valeur, setValeur] = useState(props.initiale);
  const [refusPanel, setRefusPanel] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const inchange = props.nouveau === true && valeur.trim() === props.initiale.trim();
  const local = inchange ? null : props.refus(valeur);
  const valider = () => {
    setEnvoi(true);
    props
      .valider(valeur)
      .catch((erreur: unknown) => (erreur instanceof Error ? erreur.message : String(erreur)))
      .then((refus) => {
        setEnvoi(false);
        setRefusPanel(refus);
        if (refus === null) props.onFermer();
      });
  };
  return (
    <>
      <Texte ton="titre">{props.titre}</Texte>
      {props.aide ? <Texte ton="discret">{props.aide}</Texte> : null}
      <Champ
        libelle={props.libelle}
        value={valeur}
        onChangeText={(texte) => {
          setValeur(texte);
          setRefusPanel(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
      />
      {refusPanel ? <Bandeau titre={refusPanel} niveau="danger" /> : null}
      {local && valeur !== "" ? <Texte ton="danger">{local}</Texte> : null}
      <Bouton
        titre={props.action}
        inactif={inchange || local !== null || envoi}
        onPress={valider}
      />
    </>
  );
}
