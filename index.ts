import "dotenv/config";
import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import express from "express";
import session from "express-session";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "./generated/prisma/client";
import { ALLOWED_EMAIL_DOMAINS, isAllowedEmail, BOOK_CONDITIONS, isAllowedCondition } from "./constants";

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

async function loadBooksPageData() {
  const [books, courses] = await Promise.all([
    prisma.book.findMany({ include: { courses: { include: { course: true } } } }),
    prisma.course.findMany({ orderBy: [{ name: "asc" }, { year: "desc" }] }),
  ]);
  return { books, courses };
}

app.get("/books", async (req, res) => {
  const { books, courses } = await loadBooksPageData();
  res.render("books", { books, courses, error: null });
});

app.post("/books", requireLogin, async (req, res) => {
  const title = req.body.title;
  const author = req.body.author;
  const isbn = req.body.isbn ? req.body.isbn : null;
  const publisher = req.body.publisher || null;
  const edition = req.body.edition || null;

  if (!title || !author) {
    const { books, courses } = await loadBooksPageData();
    return res.status(400).render("books", { books, courses, error: "タイトルと著者は必須です" });
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

app.post("/books/:id/courses", requireLogin, async (req, res) => {
  const bookId = Number(req.params.id);
  const courseId = req.body.courseId ? Number(req.body.courseId) : null;

  const book = await prisma.book.findUnique({ where: { id: bookId } });
  if (!book || !courseId) {
    return res.redirect("/books");
  }
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) {
    return res.redirect("/books");
  }

  const existing = await prisma.courseBook.findUnique({
    where: { bookId_courseId: { bookId, courseId } },
  });
  if (existing) {
    // 既にこの本とこの授業は紐付け済み。重複作成せずそのまま戻る
    return res.redirect("/books");
  }

  try {
    await prisma.courseBook.create({ data: { bookId, courseId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.redirect("/books");
    }
    throw err;
  }

  res.redirect("/books");
});

app.get("/courses", async (req, res) => {
  const courses = await prisma.course.findMany({ orderBy: [{ name: "asc" }, { year: "desc" }] });
  res.render("courses", { courses, error: null });
});

app.post("/courses", requireLogin, async (req, res) => {
  const name = req.body.name;
  const code = req.body.code || null;
  const teacher = req.body.teacher || null;
  const year = req.body.year ? Number(req.body.year) : null;
  const term = req.body.term || null;

  if (!name) {
    const courses = await prisma.course.findMany({ orderBy: [{ name: "asc" }, { year: "desc" }] });
    return res.status(400).render("courses", { courses, error: "授業名は必須です" });
  }

  await prisma.course.create({ data: { name, code, teacher, year, term } });
  res.redirect("/courses");
});

app.get("/listings", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const courseId = req.query.courseId ? Number(req.query.courseId) : null;
  const condition = typeof req.query.condition === "string" ? req.query.condition : "";
  const listingType =
    req.query.listingType === "FIXED" || req.query.listingType === "AUCTION" ? req.query.listingType : "";
  const minPrice = req.query.minPrice ? Number(req.query.minPrice) : null;
  const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : null;

  const whereClauses: Prisma.ListingWhereInput[] = [];

  if (q) {
    whereClauses.push({
      book: {
        OR: [{ title: { contains: q, mode: "insensitive" } }, { author: { contains: q, mode: "insensitive" } }],
      },
    });
  }
  if (courseId) {
    whereClauses.push({ book: { courses: { some: { courseId } } } });
  }
  if (condition) {
    whereClauses.push({ condition });
  }
  if (listingType) {
    whereClauses.push({ listingType });
  }
  if (minPrice !== null || maxPrice !== null) {
    const priceRange = {
      gte: minPrice ?? undefined,
      lte: maxPrice ?? undefined,
    };
    whereClauses.push({
      OR: [
        { listingType: "FIXED", price: priceRange },
        { listingType: "AUCTION", currentPrice: priceRange },
      ],
    });
  }

  const [listings, courses] = await Promise.all([
    prisma.listing.findMany({
      where: { status: "ACTIVE", AND: whereClauses },
      orderBy: { createdAt: "desc" },
      include: { book: true, seller: true },
    }),
    prisma.course.findMany({ orderBy: [{ name: "asc" }, { year: "desc" }] }),
  ]);

  res.render("listings", {
    listings,
    courses,
    conditions: BOOK_CONDITIONS,
    filters: { q, courseId, condition, listingType, minPrice, maxPrice },
  });
});

app.get("/listings/new", requireLogin, async (req, res) => {
  const books = await prisma.book.findMany();
  res.render("listings_new", { books, conditions: BOOK_CONDITIONS, error: null });
});

app.post("/listings", requireLogin, async (req, res) => {
  const renderError = async (error: string) => {
    const books = await prisma.book.findMany();
    return res.status(400).render("listings_new", { books, conditions: BOOK_CONDITIONS, error });
  };

  const bookId = req.body.bookId ? Number(req.body.bookId) : null;
  const listingType = req.body.listingType;
  const condition = req.body.condition;
  const description = req.body.description || null;

  if (!bookId) {
    return renderError("教科書を選択してください");
  }
  const book = await prisma.book.findUnique({ where: { id: bookId } });
  if (!book) {
    return renderError("指定された教科書が見つかりません");
  }

  if (listingType !== "FIXED" && listingType !== "AUCTION") {
    return renderError("販売形式を選択してください");
  }

  if (!condition || !isAllowedCondition(condition)) {
    return renderError("状態を選択してください");
  }

  let price: number | null = null;
  let startingPrice: number | null = null;
  let currentPrice: number | null = null;
  let auctionEndAt: Date | null = null;

  if (listingType === "FIXED") {
    const priceValue = req.body.price ? Number(req.body.price) : null;
    if (!priceValue || priceValue <= 0) {
      return renderError("価格を入力してください");
    }
    price = priceValue;
  } else {
    const startingPriceValue = req.body.startingPrice ? Number(req.body.startingPrice) : null;
    const auctionEndAtValue = req.body.auctionEndAt ? new Date(req.body.auctionEndAt) : null;
    if (!startingPriceValue || startingPriceValue <= 0) {
      return renderError("開始価格を入力してください");
    }
    if (!auctionEndAtValue || Number.isNaN(auctionEndAtValue.getTime())) {
      return renderError("終了日時を入力してください");
    }
    startingPrice = startingPriceValue;
    currentPrice = startingPriceValue;
    auctionEndAt = auctionEndAtValue;
  }

  const listing = await prisma.listing.create({
    data: {
      bookId,
      sellerId: res.locals.currentUser.id,
      listingType,
      condition,
      description,
      price,
      startingPrice,
      currentPrice,
      auctionEndAt,
    },
  });

  res.redirect(`/listings/${listing.id}`);
});

app.get("/listings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: { book: true, seller: true },
  });
  if (!listing) {
    return res.status(404).send("Not Found");
  }
  res.render("listing_detail", { listing });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
