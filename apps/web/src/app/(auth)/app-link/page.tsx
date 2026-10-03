import { AlertBanner, AuthCard, ThemeToggle } from "@gamedashboard/ui";
import { getTranslations } from "next-intl/server";
import { AppLinkConsent } from "@/components/app-link-consent";
import { pageTitle } from "@/lib/page-title";
import { pendingAppLink } from "@/server/api/app-devices";
import { getBranding } from "@/server/api/branding";
import { fetchMe } from "@/server/api/client";
import { currentHost } from "@/server/api/forwarded";

export const generateMetadata = pageTitle("appLink", "title");

/**
 * « Autoriser l'application mobile ? » (ADR 0010).
 *
 * Ouverte dans le navigateur du téléphone par l'application. Sans session,
 * `fetchMe` mène à la connexion, et l'accueil ramène ici ensuite : la
 * demande attend dans son cookie. Le domaine et le compte sont écrits en
 * toutes lettres : c'est ce que la personne doit vérifier avant d'accepter.
 */
export default async function AppLinkPage() {
  const [t, query, branding, host] = await Promise.all([
    getTranslations("appLink"),
    pendingAppLink(),
    getBranding(),
    currentHost(),
  ]);
  const me = query ? await fetchMe() : null;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="absolute top-6 right-6">
        <ThemeToggle />
      </div>
      <AuthCard
        eyebrow={branding.name}
        title={t("title")}
        description={
          query && me
            ? t("description", {
                device: query.device_name,
                platform: t(`platform.${query.platform}`),
                email: me.email,
                host: host ?? "",
              })
            : undefined
        }
      >
        {query && me ? (
          <AppLinkConsent />
        ) : (
          <AlertBanner variant="warning" title={t("expiredTitle")}>
            {t("expiredBody")}
          </AlertBanner>
        )}
      </AuthCard>
    </div>
  );
}
