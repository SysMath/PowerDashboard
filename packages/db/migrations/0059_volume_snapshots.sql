CREATE TABLE "node_snapshots" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"policy" jsonb,
	"filesystem" varchar(8),
	"reason" text,
	"total_bytes" bigint,
	"free_bytes" bigint,
	"suspended" boolean DEFAULT false NOT NULL,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"cause" varchar(10),
	"server_id" uuid,
	"snapshot_name" varchar(32),
	"state" varchar(10) DEFAULT 'pending' NOT NULL,
	"result" varchar(32),
	"error" text,
	"requested_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volume_snapshot_pins" (
	"snapshot_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"label" varchar(80),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volume_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"name" varchar(32) NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"cause" varchar(10) DEFAULT 'auto' NOT NULL,
	"servers" uuid[] DEFAULT '{}' NOT NULL,
	"bytes" bigint,
	"server_id" uuid,
	"requested_by" uuid,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "snapshot_limit" integer;--> statement-breakpoint
ALTER TABLE "node_snapshots" ADD CONSTRAINT "node_snapshots_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_orders" ADD CONSTRAINT "snapshot_orders_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_orders" ADD CONSTRAINT "snapshot_orders_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_orders" ADD CONSTRAINT "snapshot_orders_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_snapshot_pins" ADD CONSTRAINT "volume_snapshot_pins_snapshot_id_volume_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."volume_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_snapshot_pins" ADD CONSTRAINT "volume_snapshot_pins_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_snapshot_pins" ADD CONSTRAINT "volume_snapshot_pins_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_snapshots" ADD CONSTRAINT "volume_snapshots_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_snapshots" ADD CONSTRAINT "volume_snapshots_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_snapshots" ADD CONSTRAINT "volume_snapshots_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "snapshot_order_node_state_idx" ON "snapshot_orders" USING btree ("node_id","state");--> statement-breakpoint
CREATE INDEX "snapshot_order_server_idx" ON "snapshot_orders" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "volume_snapshot_pin_unique" ON "volume_snapshot_pins" USING btree ("snapshot_id","server_id");--> statement-breakpoint
CREATE INDEX "volume_snapshot_pin_server_idx" ON "volume_snapshot_pins" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "volume_snapshot_node_name_unique" ON "volume_snapshots" USING btree ("node_id","name");--> statement-breakpoint
CREATE INDEX "volume_snapshot_node_taken_idx" ON "volume_snapshots" USING btree ("node_id","taken_at");