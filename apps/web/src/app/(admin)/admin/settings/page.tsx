import { AdminSettings } from "@/components/admin-settings";
import { AdminSnapshotDefaults } from "@/components/admin-snapshot-defaults";
import { AdminSubuserPresets } from "@/components/admin-subuser-presets";
import { pageTitle } from "@/lib/page-title";
import { CONFIGURATION_ROLES } from "@/lib/roles";
import { fetchPlatformSettings, fetchSubuserPresets } from "@/server/api/admin";
import { fetchSnapshotDefaults } from "@/server/api/admin-snapshots";
import { fetchMe } from "@/server/api/client";

export const generateMetadata = pageTitle("adminSettings", "title");

export default async function AdminSettingsPage() {
  const [presets, me] = await Promise.all([fetchSubuserPresets(), fetchMe()]);
  const canConfigure = CONFIGURATION_ROLES.has(me.role);
  // Les réglages ne se lisent qu'en administrateur : l'API les refuse au
  // support, et les demander pour lui ferait de toute la page une erreur.
  const [settings, snapshotDefaults] = canConfigure
    ? await Promise.all([fetchPlatformSettings(), fetchSnapshotDefaults()])
    : [null, null];

  return (
    <AdminSettings initial={settings}>
      <AdminSubuserPresets initial={presets} canEdit={canConfigure} />
      {snapshotDefaults ? <AdminSnapshotDefaults initial={snapshotDefaults} canEdit /> : null}
    </AdminSettings>
  );
}
