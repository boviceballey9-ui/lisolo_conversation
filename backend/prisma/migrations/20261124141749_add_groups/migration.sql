-- AlterEnum
ALTER TYPE "message_type" ADD VALUE 'SYSTEM';

-- AlterTable
ALTER TABLE "message_status" ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "read_at" TIMESTAMP(3);
