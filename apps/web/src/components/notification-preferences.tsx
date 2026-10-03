"use client";

import { AlertBanner, Badge, Switch } from "@gamedashboard/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import {
  type NotificationPreference,
  type NotificationPreferences as Preferences,
  saveNotificationPreference,
} from "@/server/api/notification-preferences";

/**
 * Ce que le compte reçoit par courriel et sur son téléphone.
 *
 * **La cloche n'est pas réglable, et c'est volontaire.** Une notification qu'on
 * n'a nulle part n'existe pas : quelqu'un qui coupe tout doit encore pouvoir
 * retrouver ce qui s'est passé en ouvrant le panel. Le seul choix qui se pose
 * est donc « est-ce que cela mérite aussi un courriel, ou le téléphone ».
 *
 * La liste vient du serveur, jamais recopiée ici : un événement ajouté côté
 * panel apparaît tout seul, et une liste tenue dans le navigateur aurait fini
 * par proposer des interrupteurs qui ne commandent rien — ce que cet écran
 * faisait précisément avant.
 */
/** Les moyens réglables ; la cloche, elle, reçoit toujours tout. */
const CHANNELS = ["email", "push"] as const;
type Channel = (typeof CHANNELS)[number];
const CHANNEL_LABELS = { email: "channelEmail", push: "channelPush" } as const;

export function NotificationPreferences({ initial }: { initial: Preferences }) {
  const t = useTranslations("notificationPrefs");
  const tc = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (preference: NotificationPreference, channel: Channel, on: boolean) =>
    startTransition(async () => {
      // Les deux moyens sont envoyés à chaque fois : le téléphone n'est
      // jamais laissé au défaut une fois que l'écran l'a montré.
      const channels = [
        "inapp",
        ...CHANNELS.filter((other) =>
          other === channel ? on : preference.channels.includes(other),
        ),
      ];
      const result = await saveNotificationPreference(preference.type, channels);
      setError(result.error);
      // L'état affiché vient du serveur : basculer l'interrupteur à l'écran
      // avant la réponse montrerait un choix qui, en cas de refus, se
      // reprendrait au rechargement suivant.
      if (!result.error) router.refresh();
    });

  const groups = new Map<string, NotificationPreference[]>();
  for (const item of initial.items) {
    groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <AlertBanner variant="danger" title={tc("actionRefused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}

      {/*
        Deux raisons pour lesquelles un courriel ne partira pas, et elles se
        corrigent à deux endroits différents : le SMTP est l'affaire de la
        plateforme, l'adresse confirmée celle du compte. Les fondre en « le
        courriel est indisponible » ferait attendre une correction qui ne
        viendrait pas.
      */}
      {!initial.mailEnabled ? (
        <AlertBanner variant="warning" title={t("noSmtpTitle")}>
          {t("noSmtpBody")}
        </AlertBanner>
      ) : !initial.emailVerified ? (
        <AlertBanner variant="warning" title={t("unverifiedTitle")}>
          {t("unverifiedBody")}
        </AlertBanner>
      ) : null}

      {!initial.pushEnabled ? (
        <AlertBanner variant="info" title={t("noPushTitle")}>
          {t("noPushBody")}
        </AlertBanner>
      ) : initial.pushDevices === 0 ? (
        <AlertBanner variant="info" title={t("noDeviceTitle")}>
          {t("noDeviceBody")}
        </AlertBanner>
      ) : null}

      {[...groups.entries()].map(([group, items]) => (
        <div key={group} className="flex flex-col gap-1">
          <div className="flex items-end justify-between gap-6">
            <p className="font-semibold text-muted text-xs uppercase tracking-wide">
              {t(`group.${group}`)}
            </p>
            <div className="flex gap-6 text-faint text-xs" aria-hidden>
              {CHANNELS.map((channel) => (
                <span key={channel} className="w-11 text-center">
                  {t(CHANNEL_LABELS[channel])}
                </span>
              ))}
            </div>
          </div>
          <div className="divide-y divide-border">
            {items.map((item) => (
              <div key={item.type} className="flex items-center justify-between gap-6 py-3">
                <div className="min-w-0">
                  <span className="block font-semibold text-fg text-sm">
                    {t(`event.${item.type}`)}
                  </span>
                  {/* Seul l'obligatoire porte une explication : les autres se
                      comprennent à leur intitulé. */}
                  {item.mandatory ? (
                    <span className="block text-muted text-xs">{t("mandatoryHint")}</span>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-6">
                  {CHANNELS.map((channel) => (
                    <Switch
                      key={channel}
                      aria-label={`${t(`event.${item.type}`)} : ${t(CHANNEL_LABELS[channel])}`}
                      checked={item.channels.includes(channel)}
                      // Verrouillé plutôt que masqué : ce qui se décide contre
                      // le client se notifie quoi qu'il arrive, et le cacher
                      // ferait croire qu'on ne prévient pas.
                      disabled={pending || item.mandatory}
                      onCheckedChange={(next) => toggle(item, channel, next)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <p className="text-faint text-xs">
        <Badge variant="neutral">{t("bellAlways")}</Badge> {t("bellAlwaysHint")}
      </p>
    </div>
  );
}
