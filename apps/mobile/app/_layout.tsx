import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FournisseurApplis } from "@/etat/applis";
import { Traductions } from "@/i18n/traductions";
import { useCouleurs } from "@/theme/theme";

/** La racine : traductions, registre des panels, navigation aux couleurs du panel. */
export default function Racine() {
  const c = useCouleurs();
  return (
    <SafeAreaProvider>
      <Traductions>
        <FournisseurApplis>
          <StatusBar style="auto" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: c.surface },
              headerTintColor: c.text,
              contentStyle: { backgroundColor: c.bg },
            }}
          >
            <Stack.Screen name="[instance]" options={{ headerShown: false }} />
          </Stack>
        </FournisseurApplis>
      </Traductions>
    </SafeAreaProvider>
  );
}
