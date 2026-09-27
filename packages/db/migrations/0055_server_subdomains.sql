-- Sous-domaines des serveurs (PLAN §10.3) : libellé choisi par le client, nom
-- complet publié, fournisseur et zone du nom, et les enregistrements posés chez
-- le fournisseur avec leur identifiant et leur zone, pour les retirer exactement
-- quand l'adresse change, que la zone change ou que le serveur disparaît.
-- server_id passe à NULL à la suppression du serveur ou à l'abandon du nom
-- (abandoned_by garde alors le serveur qui l'a quitté) : le balayage retire les
-- enregistrements, puis la ligne. Nom complet unique.
CREATE TABLE "server_subdomains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid,
	"abandoned_by" uuid,
	"label" varchar(63) NOT NULL,
	"fqdn" varchar(255) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"zone_id" varchar(64) NOT NULL,
	"records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(8) DEFAULT 'pending' NOT NULL,
	"error" varchar(500),
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_subdomains" ADD CONSTRAINT "server_subdomains_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_subdomain_fqdn_unique" ON "server_subdomains" USING btree ("fqdn");--> statement-breakpoint
CREATE UNIQUE INDEX "server_subdomain_server_unique" ON "server_subdomains" USING btree ("server_id");