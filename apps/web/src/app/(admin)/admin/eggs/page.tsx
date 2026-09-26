import { AdminEggs } from "@/components/admin-eggs";
import { pageTitle } from "@/lib/page-title";
import { fetchAdminEggs, readEggCatalogue } from "@/server/api/admin";

export const generateMetadata = pageTitle("adminEggs", "title");

export default async function AdminEggsPage() {
  // Les deux lectures partent ensemble : le catalogue local et ce que le dépôt
  // propose s'affichent sur le même écran, et les enchaîner ajouterait leurs
  // latences — dont un aller-retour vers GitHub. Un catalogue injoignable
  // n'empêche pas de gérer les eggs locaux (`readEggCatalogue`).
  const [eggs, catalogue] = await Promise.all([fetchAdminEggs(), readEggCatalogue()]);

  return (
    <AdminEggs
      initial={eggs}
      source={catalogue.source}
      entries={catalogue.entries}
      catalogueError={catalogue.error}
      catalogueStaleSince={catalogue.staleSince}
    />
  );
}
