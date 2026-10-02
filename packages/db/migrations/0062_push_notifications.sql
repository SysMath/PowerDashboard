CREATE TABLE "push_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"type" varchar(64) NOT NULL,
	"server_name" varchar(64),
	"locale" varchar(10) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_relay_handles" (
	"handle_hash" varchar(64) PRIMARY KEY NOT NULL,
	"instance" varchar(100) NOT NULL,
	"expo_token" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_relay_instances" (
	"instance" varchar(100) PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_devices" ADD COLUMN "push_mode" varchar(8);--> statement-breakpoint
ALTER TABLE "app_devices" ADD COLUMN "push_handle" varchar(160);--> statement-breakpoint
ALTER TABLE "push_outbox" ADD CONSTRAINT "push_outbox_device_id_app_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."app_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_relay_handles" ADD CONSTRAINT "push_relay_handles_instance_push_relay_instances_instance_fk" FOREIGN KEY ("instance") REFERENCES "public"."push_relay_instances"("instance") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_outbox_due_idx" ON "push_outbox" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_relay_handle_token_unique" ON "push_relay_handles" USING btree ("instance","expo_token");