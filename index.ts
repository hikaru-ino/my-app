import "dotenv/config";
import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import express from "express";
import session from "express-session";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "./generated/prisma/client";
import { ALLOWED_EMAIL_DOMAINS, isAllowedEmail } from "./constants";

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

app.set("trust proxy", 1); // RenderのHTTPSリバースプロキシ越しでsecure cookieを送るために必要

// セッションストアはデフォルトのMemoryStoreを使用している。
// Renderの再起動・スケール時にセッションが全消失するため、将来的にはconnect-pg-simple等の永続ストアに差し替える想定。
app.use(
  session({
    secret: process.env.SESSION_SECRET as string,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1週間
    },
  })
);

app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.userId
    ? await prisma.user.findUnique({ where: { id: req.session.userId } })
    : null;
  next();
});

function requireLogin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!res.locals.currentUser) {
    return res.redirect("/login");
  }
  next();
}

app.get("/", (req, res) => {
  res.render("index");
});

app.get("/signup", (req, res) => {
  res.render("signup", { error: null });
});

app.post("/signup", async (req, res) => {
  const email = req.body.email;
  const password = req.body.password;
  const name = req.body.name;

  if (!email || !password || !name) {
    return res.status(400).render("signup", { error: "すべての項目を入力してください" });
  }
  if (!isAllowedEmail(email)) {
    return res.status(400).render("signup", {
      error: `登録できるのは ${ALLOWED_EMAIL_DOMAINS.join(", ")} のメールアドレスのみです`,
    });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(400).render("signup", { error: "このメールアドレスは既に登録されています" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const verificationToken = randomBytes(32).toString("hex");

  const user = await prisma.user.create({
    data: { email, passwordHash, name, verificationToken },
  });

  // TODO: SMTP実装後はここでverificationTokenをメール送信する
  console.log(`[verification] ${email} 宛のトークン: ${verificationToken}`);

  req.session.userId = user.id;
  res.redirect("/");
});

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  const email = req.body.email;
  const password = req.body.password;

  const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
  const valid = user && password ? await bcrypt.compare(password, user.passwordHash) : false;

  if (!user || !valid) {
    return res.status(400).render("login", { error: "メールアドレスまたはパスワードが違います" });
  }

  req.session.userId = user.id;
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/books", async (req, res) => {
  const books = await prisma.book.findMany();
  res.render("books", { books, error: null });
});

app.post("/books", requireLogin, async (req, res) => {
  const title = req.body.title;
  const author = req.body.author;
  const isbn = req.body.isbn ? req.body.isbn : null;
  const publisher = req.body.publisher || null;
  const edition = req.body.edition || null;

  if (!title || !author) {
    const books = await prisma.book.findMany();
    return res.status(400).render("books", { books, error: "タイトルと著者は必須です" });
  }

  if (isbn) {
    const existing = await prisma.book.findUnique({ where: { isbn } });
    if (existing) {
      // 既に同じISBNの教科書が登録済み。重複作成せず既存レコードをそのまま使う
      return res.redirect("/books");
    }
  }

  try {
    await prisma.book.create({ data: { title, author, isbn, publisher, edition } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // 事前チェックとcreateの間で他リクエストが同じISBNを先に登録した場合の保険
      return res.redirect("/books");
    }
    throw err;
  }

  res.redirect("/books");
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
