ALTER TABLE `session` ADD `cost` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_input` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_output` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_reasoning` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_cache_read` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_cache_write` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `session` SET
  `cost` = COALESCE((SELECT SUM(COALESCE(json_extract(`part`.`data`, '$.cost'), 0)) FROM `part` WHERE `part`.`session_id` = `session`.`id` AND json_extract(`part`.`data`, '$.type') = 'step-finish'), 0),
  `tokens_input` = COALESCE((SELECT SUM(COALESCE(json_extract(`part`.`data`, '$.tokens.input'), 0)) FROM `part` WHERE `part`.`session_id` = `session`.`id` AND json_extract(`part`.`data`, '$.type') = 'step-finish'), 0),
  `tokens_output` = COALESCE((SELECT SUM(COALESCE(json_extract(`part`.`data`, '$.tokens.output'), 0)) FROM `part` WHERE `part`.`session_id` = `session`.`id` AND json_extract(`part`.`data`, '$.type') = 'step-finish'), 0),
  `tokens_reasoning` = COALESCE((SELECT SUM(COALESCE(json_extract(`part`.`data`, '$.tokens.reasoning'), 0)) FROM `part` WHERE `part`.`session_id` = `session`.`id` AND json_extract(`part`.`data`, '$.type') = 'step-finish'), 0),
  `tokens_cache_read` = COALESCE((SELECT SUM(COALESCE(json_extract(`part`.`data`, '$.tokens.cache.read'), 0)) FROM `part` WHERE `part`.`session_id` = `session`.`id` AND json_extract(`part`.`data`, '$.type') = 'step-finish'), 0),
  `tokens_cache_write` = COALESCE((SELECT SUM(COALESCE(json_extract(`part`.`data`, '$.tokens.cache.write'), 0)) FROM `part` WHERE `part`.`session_id` = `session`.`id` AND json_extract(`part`.`data`, '$.type') = 'step-finish'), 0);