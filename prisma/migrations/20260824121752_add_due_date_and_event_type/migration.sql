-- AlterTable
ALTER TABLE `notification_attempts` ADD COLUMN `eventType` VARCHAR(191) NOT NULL DEFAULT 'task.archived';

-- AlterTable
ALTER TABLE `tasks` ADD COLUMN `dueDate` DATETIME(3) NULL,
    ADD COLUMN `dueSoonNotifiedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `notification_attempts_taskId_eventType_idx` ON `notification_attempts`(`taskId`, `eventType`);

-- CreateIndex
CREATE INDEX `tasks_status_dueDate_idx` ON `tasks`(`status`, `dueDate`);
