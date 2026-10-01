ALTER TABLE "backups" ADD COLUMN "source" varchar(10) DEFAULT 'wings' NOT NULL;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "snapshot_name" varchar(32);--> statement-breakpoint
ALTER TABLE "snapshot_orders" ADD COLUMN "backup_id" uuid;--> statement-breakpoint
ALTER TABLE "snapshot_orders" ADD CONSTRAINT "snapshot_orders_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "snapshot_order_backup_idx" ON "snapshot_orders" USING btree ("backup_id");