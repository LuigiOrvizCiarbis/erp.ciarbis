-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emailVerifToken" TEXT,
ADD COLUMN     "emailVerificado" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "users_emailVerifToken_key" ON "users"("emailVerifToken");
