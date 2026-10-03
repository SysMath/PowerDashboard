"use client";

import { AlertBanner, Button } from "@gamedashboard/ui";
import { Smartphone, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { answerAppLink } from "@/server/api/app-devices";

/**
 * Les deux boutons de la liaison, et le retour vers l'application.
 *
 * Le retour se fait par `window.location`, côté navigateur : c'est une
 * adresse `gamedashboard://`, qu'une redirection d'action serveur ne sait pas
 * suivre, et que la CSP (`form-action`) refuserait à un formulaire.
 */
export function AppLinkConsent() {
  const t = useTranslations("appLink");
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "sent" | "expired" | "failed">("idle");

  const answer = (approved: boolean) =>
    startTransition(async () => {
      const result = await answerAppLink(approved);
      if (result.redirect) window.location.assign(result.redirect);
      setState(result.error === "expired" ? "expired" : result.error ? "failed" : "sent");
    });

  if (state === "sent") {
    return (
      <AlertBanner variant="success" title={t("sentTitle")}>
        {t("sentBody")}
      </AlertBanner>
    );
  }
  if (state !== "idle") {
    return (
      <AlertBanner variant="danger" title={t("failedTitle")}>
        {t(state === "expired" ? "expiredBody" : "failedBody")}
      </AlertBanner>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Button size="lg" fullWidth disabled={pending} onClick={() => answer(true)}>
        <Smartphone /> {t("approve")}
      </Button>
      <Button
        size="lg"
        fullWidth
        variant="secondary"
        disabled={pending}
        onClick={() => answer(false)}
      >
        <X /> {t("refuse")}
      </Button>
      <p className="text-center text-muted text-xs">{t("notice")}</p>
    </div>
  );
}
