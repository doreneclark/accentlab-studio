CREATE TABLE `huggingFaceGenerationLeases` (
	`ownerEmail` varchar(320) NOT NULL,
	`state` enum('idle','active','pausing') NOT NULL DEFAULT 'idle',
	`generationId` varchar(64) NOT NULL DEFAULT '',
	`expiresAt` timestamp NOT NULL,
	CONSTRAINT `huggingFaceGenerationLeases_ownerEmail` PRIMARY KEY(`ownerEmail`)
);
