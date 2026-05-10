ALTER TABLE `session` ADD `cost` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_input` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_output` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_reasoning` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_cache_read` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_cache_write` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TEMP TABLE `session_usage` AS
SELECT
  `part`.`session_id`,
  COALESCE(SUM(COALESCE(json_extract(`part`.`data`, '$.cost'), 0)), 0) AS `cost`,
  COALESCE(SUM(COALESCE(json_extract(`part`.`data`, '$.tokens.input'), 0)), 0) AS `tokens_input`,
  COALESCE(SUM(COALESCE(json_extract(`part`.`data`, '$.tokens.output'), 0)), 0) AS `tokens_output`,
  COALESCE(SUM(COALESCE(json_extract(`part`.`data`, '$.tokens.reasoning'), 0)), 0) AS `tokens_reasoning`,
  COALESCE(SUM(COALESCE(json_extract(`part`.`data`, '$.tokens.cache.read'), 0)), 0) AS `tokens_cache_read`,
  COALESCE(SUM(COALESCE(json_extract(`part`.`data`, '$.tokens.cache.write'), 0)), 0) AS `tokens_cache_write`
FROM `part`
WHERE json_extract(`part`.`data`, '$.type') = 'step-finish'
GROUP BY `part`.`session_id`;--> statement-breakpoint
UPDATE `session` SET
  `cost` = COALESCE((SELECT `cost` FROM `session_usage` WHERE `session_usage`.`session_id` = `session`.`id`), 0),
  `tokens_input` = COALESCE((SELECT `tokens_input` FROM `session_usage` WHERE `session_usage`.`session_id` = `session`.`id`), 0),
  `tokens_output` = COALESCE((SELECT `tokens_output` FROM `session_usage` WHERE `session_usage`.`session_id` = `session`.`id`), 0),
  `tokens_reasoning` = COALESCE((SELECT `tokens_reasoning` FROM `session_usage` WHERE `session_usage`.`session_id` = `session`.`id`), 0),
  `tokens_cache_read` = COALESCE((SELECT `tokens_cache_read` FROM `session_usage` WHERE `session_usage`.`session_id` = `session`.`id`), 0),
  `tokens_cache_write` = COALESCE((SELECT `tokens_cache_write` FROM `session_usage` WHERE `session_usage`.`session_id` = `session`.`id`), 0);--> statement-breakpoint
DROP TABLE `session_usage`;
