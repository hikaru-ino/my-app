import "dotenv/config";
import express from "express";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter, log: ["query"] });

const app = express();
const PORT = process.env.PORT || 8888;

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.urlencoded({ extended: true }));

app.get("/", async (req, res) => {
  const users = await prisma.user.findMany();
  res.render("index", { users });
});

app.post("/users", async (req, res) => {
  const name = req.body.name;
  const age = req.body.age ? Number(req.body.age) : null; // 数字に変換するのじゃ
  if (name) {
    await prisma.user.create({ data: { name, age } });
  }
  res.redirect("/");
});

app.get("/books", async (req, res) => {
  const books = await prisma.book.findMany();
  res.render("books", { books });
});

app.post("/books", async (req, res) => {
  const title = req.body.title;
  const author = req.body.author;
  const price = req.body.price ? Number(req.body.price) : null;
  const course = req.body.course || null;
  if (title && author && price !== null) {
    await prisma.book.create({ data: { title, author, price, course } });
  }
  res.redirect("/books");
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
