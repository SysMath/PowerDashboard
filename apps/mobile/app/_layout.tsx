import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FournisseurApplis } from "@/etat/applis";
import { useToucherNotification } from "@/hooks/usePousse";
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
          <ToucherNotifications />
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

/** Écoute le toucher des notifications, sous le registre des panels. */
function ToucherNotifications() {
  useToucherNotification();
  return null;
}
