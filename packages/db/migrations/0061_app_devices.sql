CREATE TABLE "app_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"platform" varchar(16) NOT NULL,
	"app_version" varchar(32),
	"public_key" text NOT NULL,
	"secret_hash" text NOT NULL,
	"previous_secret_hash" text,
	"access_token_hash" text,
	"access_expires_at" timestamp with time zone,
	"challenge_hash" text,
	"challenge_expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_ip" "inet",
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(24),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"code_challenge" varchar(64) NOT NULL,
	"device_name" varchar(80) NOT NULL,
	"platform" varchar(16) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_devices" ADD CONSTRAINT "app_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_link_codes" ADD CONSTRAINT "app_link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_link_codes" ADD CONSTRAINT "app_link_codes_device_id_app_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."app_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_device_access_token_unique" ON "app_devices" USING btree ("access_token_hash");--> statement-breakpoint
CREATE INDEX "app_device_user_idx" ON "app_devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_link_code_hash_unique" ON "app_link_codes" USING btree ("code_hash");