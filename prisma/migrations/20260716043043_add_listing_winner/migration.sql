-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "winnerId" INTEGER;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
