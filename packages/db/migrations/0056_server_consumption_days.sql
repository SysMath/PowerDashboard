-- Consommation journalière des serveurs (PLAN §10.3, métriques exportables) :
-- résumé d'une journée UTC par serveur, recalculé chaque heure depuis
-- server_metrics et gardé treize mois. Sans clé étrangère vers servers : la
-- consommation d'un serveur supprimé reste due à sa dernière facture.
CREATE TABLE "server_consumption_days" (
	"day" date NOT NULL,
	"server_id" uuid NOT NULL,
	"server_name" varchar(120) NOT NULL,
	"owner_id" uuid,
	"reseller_id" uuid,
	"memory_limit_mb" integer NOT NULL,
	"disk_limit_mb" integer NOT NULL,
	"cpu_limit_pct" integer NOT NULL,
	"samples" integer NOT NULL,
	"online_samples" integer NOT NULL,
	"cpu_avg_pct" real,
	"cpu_max_pct" real,
	"memory_avg_bytes" bigint,
	"memory_max_bytes" bigint,
	"disk_max_bytes" bigint,
	"network_rx_bytes" bigint NOT NULL,
	"network_tx_bytes" bigint NOT NULL,
	"players_max" integer,
	"rolled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "server_consumption_day_pk" PRIMARY KEY("server_id","day")
);
--> statement-breakpoint
ALTER TABLE "server_consumption_days" ADD CONSTRAINT "server_consumption_days_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_consumption_days" ADD CONSTRAINT "server_consumption_days_reseller_id_users_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_consumption_day_idx" ON "server_consumption_days" USING btree ("day");--> statement-breakpoint
CREATE INDEX "server_consumption_owner_day_idx" ON "server_consumption_days" USING btree ("owner_id","day");--> statement-breakpoint
CREATE INDEX "server_consumption_reseller_day_idx" ON "server_consumption_days" USING btree ("reseller_id","day");