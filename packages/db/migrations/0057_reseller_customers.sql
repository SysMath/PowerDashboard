-- Le revendeur qui a créé un compte par la clé de sa boutique. Une clé de
-- revendeur ne donne plus un serveur qu'à un compte qu'elle sert déjà ou
-- qu'elle a créé : c'est ce qui fermait le chemin « créer un serveur chez un
-- compte qui n'est à personne, puis lui ouvrir une session ».
CREATE TABLE "reseller_customers" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"reseller_id" uuid NOT NULL,
	"origin" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reseller_customers" ADD CONSTRAINT "reseller_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_customers" ADD CONSTRAINT "reseller_customers_reseller_id_users_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reseller_customers_reseller_idx" ON "reseller_customers" USING btree ("reseller_id");--> statement-breakpoint
-- Rattrapage des comptes existants, par la trace de création (journal
-- `application.user_created`), et seulement quand elle désigne un revendeur
-- sans ambiguïté : l'acteur y est inscrit par le **nom** de la clé, donc un
-- nom porté par une seule clé, bornée à un revendeur. Un compte client
-- seulement, qui ne possède aucun serveur hors de ce revendeur. Tout le reste
-- reste sans créateur : ce qu'un revendeur sert déjà se lit sur les serveurs.
--
-- Le nom n'est unique qu'**aujourd'hui** : supprimer un revendeur supprime ses
-- clés, et un confrère qui porte le même nom (« WHMCS ») héritait alors de ses
-- comptes. D'où deux conditions de plus :
-- - la clé existait déjà quand la trace a été écrite : une trace antérieure à
--   la clé ne peut pas venir d'elle ;
-- - aucun compte n'a été supprimé depuis la trace par quelqu'un qui aurait pu
--   supprimer un revendeur (l'administration, ou une clé qui n'est pas
--   seulement une clé de revendeur, lesquelles ne suppriment que des
--   clients). Large, mais c'est le seul cas où deux clés homonymes ont pu
--   coexister sans en laisser la trace : refuser trop, jamais trop peu.
INSERT INTO "reseller_customers" ("user_id", "reseller_id", "origin")
SELECT DISTINCT ON (u."id") u."id", k."reseller_id", 'journal'
FROM "activity_logs" a
JOIN "users" u ON u."id"::text = a."properties"->>'userId'
JOIN "application_keys" k ON a."actor_label" = 'application:' || k."name"
WHERE a."event" = 'application.user_created'
  AND a."actor_type" = 'api_key'
  AND u."role" = 'user'
  AND k."reseller_id" IS NOT NULL
  AND k."created_at" <= a."at"
  AND (SELECT count(*) FROM "application_keys" k2 WHERE k2."name" = k."name") = 1
  AND NOT EXISTS (
    SELECT 1 FROM "servers" s
    WHERE s."owner_id" = u."id" AND s."reseller_id" IS DISTINCT FROM k."reseller_id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "activity_logs" d
    WHERE d."at" > a."at"
      AND (
        d."event" = 'admin.user_deleted'
        OR (
          d."event" = 'application.user_deleted'
          AND NOT (
            EXISTS (
              SELECT 1 FROM "application_keys" k3
              WHERE d."actor_label" = 'application:' || k3."name"
            )
            AND NOT EXISTS (
              SELECT 1 FROM "application_keys" k4
              WHERE d."actor_label" = 'application:' || k4."name" AND k4."reseller_id" IS NULL
            )
          )
        )
      )
  )
ORDER BY u."id", a."at"
ON CONFLICT ("user_id") DO NOTHING;
