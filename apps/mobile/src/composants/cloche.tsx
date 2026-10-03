import type { ClientNotificationView } from "@gamedashboard/contracts";
import { useFormatter, useTranslations } from "use-intl";
import { Bandeau, Carte, Pastille, Rangee, Texte } from "./base";

/** Une notification de la cloche, avec le texte complet lu par l'API. */
export function ListeNotifications(props: {
  notifications: ClientNotificationView[];
  onOuvrir: (notification: ClientNotificationView) => void;
}) {
  const t = useTranslations("mobile.cloche");
  const format = useFormatter();
  if (props.notifications.length === 0) return <Bandeau titre={t("vide")} />;
  return props.notifications.map((notification) => (
    <Carte key={notification.id} onPress={() => props.onOuvrir(notification)}>
      <Rangee>
        <Pastille niveau={notification.readAt ? "neutre" : notification.level} />
        <Texte>{notification.title}</Texte>
      </Rangee>
      <Texte ton="discret">{notification.body}</Texte>
      <Texte ton="discret">
        {notification.source ? `${notification.source} · ` : ""}
        {format.relativeTime(new Date(notification.createdAt))}
      </Texte>
    </Carte>
  ));
}
