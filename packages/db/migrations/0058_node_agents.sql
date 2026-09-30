CREATE TABLE "node_agents" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"token_id" varchar(32) NOT NULL,
	"token_enc" text NOT NULL,
	"token_issued_at" timestamp with time zone NOT NULL,
	"version" varchar(32),
	"functions" text[] DEFAULT '{}' NOT NULL,
	"functions_seen" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"journal_acked_id" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_agents" ADD CONSTRAINT "node_agents_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "node_agent_token_id_unique" ON "node_agents" USING btree ("token_id");