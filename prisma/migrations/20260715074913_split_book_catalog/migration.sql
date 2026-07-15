/*
  Warnings:

  - You are about to drop the column `course` on the `Book` table. All the data in the column will be lost.
  - You are about to drop the column `price` on the `Book` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[isbn]` on the table `Book` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Book" DROP COLUMN "course",
DROP COLUMN "price",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "edition" TEXT,
ADD COLUMN     "isbn" TEXT,
ADD COLUMN     "publisher" TEXT;

-- CreateTable
CREATE TABLE "Course" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "teacher" TEXT,
    "year" INTEGER,
    "term" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseBook" (
    "id" SERIAL NOT NULL,
    "bookId" INTEGER NOT NULL,
    "courseId" INTEGER NOT NULL,

    CONSTRAINT "CourseBook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourseBook_bookId_courseId_key" ON "CourseBook"("bookId", "courseId");

-- CreateIndex
CREATE UNIQUE INDEX "Book_isbn_key" ON "Book"("isbn");

-- AddForeignKey
ALTER TABLE "CourseBook" ADD CONSTRAINT "CourseBook_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseBook" ADD CONSTRAINT "CourseBook_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
