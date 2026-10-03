"use client";

import type { AppDeviceSummary } from "@gamedashboard/contracts";
import { AlertBanner, Button, EmptyState, RelativeTime, SettingsSection } from "@gamedashboard/ui";
import { Smartphone, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { revokeAppDevice } from "@/server/api/app-devices";

/**
 * Compte › Sécurité › Application mobile (ADR 0010).
 *
 * Le code QR ne porte que l'adresse du panel : l'application le scanne, puis
 * la connexion se fait dans le navigateur du téléphone. Dessous, les
 * téléphones liés, chacun retirable : son jeton cesse de valoir sur-le-champ.
 */
export function AppDevicesSection({
  devices,
  qr,
}: {
  devices: AppDeviceSummary[];
  qr: { address: string; qrSvg: string } | null;
}) {
  const t = useTranslations("security");
  const tc = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const remove = (id: string) =>
    startTransition(async () => {
      const result = await revokeAppDevice(id);
      setError(result.error);
      if (!result.error) router.refresh();
    });

  return (
    <SettingsSection title={t("appSection")} description={t("appSectionHint")}>
      {qr ? (
        <div className="mb-5 flex flex-wrap items-center gap-5">
          {/* Fond blanc : un code QR garde son contraste en thème sombre. */}
          <div className="rounded-card bg-white p-2">
            {/* biome-ignore lint/performance/noImgElement: image SVG en ligne, sans optimisation possible */}
            <img src={qr.qrSvg} alt={t("appQrAlt")} width={160} height={160} />
          </div>
          <p className="min-w-0 flex-1 text-muted text-sm">
            {t("appQrHint")} <span className="gd-mono text-fg">{qr.address}</span>
          </p>
        </div>
      ) : null}

      {error ? (
        <AlertBanner variant="danger" title={tc("actionRefused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}

      {devices.length === 0 ? (
        <EmptyState icon={<Smartphone />} title={t("appNoDevice")} />
      ) : (
        <ul className="divide-y divide-border" data-instable-liste="">
          {devices.map((device) => (
            <li key={device.id} className="flex items-center gap-3 py-3">
              <Smartphone className="size-[18px] text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-fg">{device.name}</p>
                <p className="text-muted text-xs">
                  {t(`appPlatform.${device.platform}`)} · {t("appLinked")}{" "}
                  <RelativeTime value={device.createdAt} />
                  {device.lastSeenAt ? (
                    <>
                      {" "}
                      · {t("columnLastSeen")} <RelativeTime value={device.lastSeenAt} />
                    </>
                  ) : null}
                </p>
              </div>
              <Button
                variant="danger-ghost"
                size="sm"
                disabled={pending}
                onClick={() => remove(device.id)}
              >
                <Trash2 /> {t("appRemove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
