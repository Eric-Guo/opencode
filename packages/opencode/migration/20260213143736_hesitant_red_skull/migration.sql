CREATE TABLE `control_account` (
	`email` text NOT NULL,
	`url` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`token_expiry` integer,
	`active` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `control_account_pk` PRIMARY KEY(`email`, `url`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_account_active_idx` ON `control_account` (`email`) WHERE "control_account"."active" = ?;