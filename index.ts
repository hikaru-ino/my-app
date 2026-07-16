import "dotenv/config";
import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import express from "express";
import session from "express-session";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "./generated/prisma/client";
import {
  ALLOWED_EMAIL_DOMAINS,
  isAllowedEmail,
  BOOK_CONDITIONS,
  isAllowedCondition,
  CAMPUSES,
  CAMPUS_LABELS,
  isAllowedCampus,
} from "./constants";

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

class BidError extends Error {}
class PurchaseError extends Error {}

// ACTIVEかつauctionEndAtを過ぎたAUCTIONを確定する。何度呼んでも安全(冪等)。
// Bid受付時・詳細表示時・一覧表示時のいずれからも呼ばれる遅延評価(lazy finalize)方式。
async function finalizeIfExpired(client: Prisma.TransactionClient, listingId: number) {
  const listing = await client.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.listingType !== "AUCTION" || listing.status !== "ACTIVE") {
    return;
  }
  if (!listing.auctionEndAt || listing.auctionEndAt > new Date()) {
    return;
  }

  const topBid = await client.bid.findFirst({
    where: { listingId },
    orderBy: { amount: "desc" },
  });

  const updated = await client.listing.updateMany({
    where: { id: listingId, status: "ACTIVE" },
    data: topBid ? { status: "IN_TRANSACTION", winnerId: topBid.bidderId } : { status: "CANCELLED" },
  });

  if (updated.count > 0 && topBid) {
    await client.order.create({
      data: { listingId, buyerId: topBid.bidderId, price: listing.currentPrice ?? topBid.amount },
    });
  }
}

async function finalizeExpiredAuctions() {
  const expired = await prisma.listing.findMany({
    where: { listingType: "AUCTION", status: "ACTIVE", auctionEndAt: { lt: new Date() } },
    select: { id: true },
  });
  for (const { id } of expired) {
    await prisma.$transaction((tx) => finalizeIfExpired(tx, id));
  }
}

async function loadListingDetail(id: number) {
  await prisma.$transaction((tx) => finalizeIfExpired(tx, id));
  return prisma.listing.findUnique({
    where: { id },
    include: {
      book: true,
      seller: true,
      winner: true,
      bids: { include: { bidder: true }, orderBy: { amount: "desc" } },
      order: true,
    },
  });
}

app.get("/listings", async (req, res) => {
  await finalizeExpiredAuctions();

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
  const listing = await loadListingDetail(id);
  if (!listing) {
    return res.status(404).send("Not Found");
  }
  res.render("listing_detail", { listing, error: null });
});

app.post("/listings/:id/bids", requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  const amount = req.body.amount ? Number(req.body.amount) : null;
  const bidderId = res.locals.currentUser.id;

  const renderError = async (error: string) => {
    const listing = await loadListingDetail(id);
    if (!listing) {
      return res.status(404).send("Not Found");
    }
    return res.status(400).render("listing_detail", { listing, error });
  };

  if (!amount || amount <= 0) {
    return renderError("入札額を入力してください");
  }

  try {
    await prisma.$transaction(async (tx) => {
      await finalizeIfExpired(tx, id);

      const listing = await tx.listing.findUnique({ where: { id } });
      if (!listing) {
        throw new BidError("出品が見つかりません");
      }
      if (listing.listingType !== "AUCTION") {
        throw new BidError("この出品には入札できません");
      }
      if (listing.sellerId === bidderId) {
        throw new BidError("自分の出品には入札できません");
      }
      if (listing.status !== "ACTIVE" || (listing.auctionEndAt && listing.auctionEndAt < new Date())) {
        throw new BidError("この出品は既に終了しています");
      }

      const updated = await tx.listing.updateMany({
        where: { id, status: "ACTIVE", currentPrice: { lt: amount } },
        data: { currentPrice: amount },
      });
      if (updated.count === 0) {
        throw new BidError("現在価格より高い金額を入力してください");
      }

      await tx.bid.create({ data: { listingId: id, bidderId, amount } });
    });
  } catch (err) {
    if (err instanceof BidError) {
      return renderError(err.message);
    }
    throw err;
  }

  res.redirect(`/listings/${id}`);
});

app.post("/listings/:id/orders", requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  const buyerId = res.locals.currentUser.id;

  const renderError = async (error: string) => {
    const listing = await loadListingDetail(id);
    if (!listing) {
      return res.status(404).send("Not Found");
    }
    return res.status(400).render("listing_detail", { listing, error });
  };

  const listing = await prisma.listing.findUnique({ where: { id } });
  if (!listing) {
    return res.status(404).send("Not Found");
  }
  if (listing.listingType !== "FIXED") {
    return renderError("この出品には購入できません");
  }
  if (listing.sellerId === buyerId) {
    return renderError("自分の出品は購入できません");
  }

  let order;
  try {
    order = await prisma.$transaction(async (tx) => {
      const updated = await tx.listing.updateMany({
        where: { id, status: "ACTIVE" },
        data: { status: "IN_TRANSACTION" },
      });
      if (updated.count === 0) {
        throw new PurchaseError("この出品は既に取引中か終了しています");
      }
      return tx.order.create({ data: { listingId: id, buyerId, price: listing.price! } });
    });
  } catch (err) {
    if (err instanceof PurchaseError) {
      return renderError(err.message);
    }
    throw err;
  }

  res.redirect(`/orders/${order.id}`);
});

app.post("/listings/:id/conversations", requireLogin, async (req, res) => {
  const listingId = Number(req.params.id);
  const buyerId = res.locals.currentUser.id;

  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) {
    return res.status(404).send("Not Found");
  }
  if (listing.sellerId === buyerId) {
    return res.status(400).send("自分の出品には質問できません");
  }

  const conversation = await prisma.conversation.upsert({
    where: { listingId_buyerId: { listingId, buyerId } },
    update: {},
    create: { listingId, buyerId },
  });

  res.redirect(`/conversations/${conversation.id}`);
});

// Conversationの当事者(買い手 or その出品の出品者)以外には存在自体を明かさないため、
// 権限がない場合は403ではなくnullを返す(呼び出し側で404にする)。
async function loadConversationForUser(id: number, userId: number) {
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      listing: { include: { book: true, seller: true } },
      buyer: true,
      messages: { include: { sender: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!conversation) {
    return null;
  }
  const isParticipant = conversation.buyerId === userId || conversation.listing.sellerId === userId;
  return isParticipant ? conversation : null;
}

app.get("/conversations", requireLogin, async (req, res) => {
  const userId = res.locals.currentUser.id;

  const conversations = await prisma.conversation.findMany({
    where: { OR: [{ buyerId: userId }, { listing: { sellerId: userId } }] },
    include: {
      listing: { include: { book: true, seller: true } },
      buyer: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  const sorted = conversations
    .map((c) => ({
      ...c,
      isSeller: c.listing.sellerId === userId,
      lastMessageAt: c.messages[0]?.createdAt ?? c.createdAt,
    }))
    .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());

  res.render("conversations", { conversations: sorted });
});

app.get("/conversations/:id", requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  const conversation = await loadConversationForUser(id, res.locals.currentUser.id);
  if (!conversation) {
    return res.status(404).send("Not Found");
  }
  res.render("conversation_detail", { conversation, error: null });
});

app.post("/conversations/:id/messages", requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";

  const conversation = await loadConversationForUser(id, res.locals.currentUser.id);
  if (!conversation) {
    return res.status(404).send("Not Found");
  }

  if (!body) {
    return res.status(400).render("conversation_detail", { conversation, error: "メッセージを入力してください" });
  }

  await prisma.message.create({
    data: { conversationId: id, senderId: res.locals.currentUser.id, body },
  });

  res.redirect(`/conversations/${id}`);
});

// Orderの当事者(買い手 or その出品の出品者)以外には存在自体を明かさないため、
// 権限がない場合は403ではなくnullを返す(呼び出し側で404にする)。
async function loadOrderForUser(id: number, userId: number) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      listing: { include: { book: true, seller: true } },
      buyer: true,
    },
  });
  if (!order) {
    return null;
  }
  const isParticipant = order.buyerId === userId || order.listing.sellerId === userId;
  return isParticipant ? order : null;
}

app.get("/orders", requireLogin, async (req, res) => {
  const userId = res.locals.currentUser.id;

  const orders = await prisma.order.findMany({
    where: { OR: [{ buyerId: userId }, { listing: { sellerId: userId } }] },
    include: {
      listing: { include: { book: true, seller: true } },
      buyer: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const withRole = orders.map((order) => ({ ...order, isSeller: order.listing.sellerId === userId }));

  res.render("orders", { orders: withRole, campusLabels: CAMPUS_LABELS });
});

app.get("/orders/:id", requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  const order = await loadOrderForUser(id, res.locals.currentUser.id);
  if (!order) {
    return res.status(404).send("Not Found");
  }
  res.render("order_detail", { order, error: null, campuses: CAMPUSES, campusLabels: CAMPUS_LABELS });
});

app.post("/orders/:id/meetup", requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  const order = await loadOrderForUser(id, res.locals.currentUser.id);
  if (!order) {
    return res.status(404).send("Not Found");
  }

  const renderError = (error: string) =>
    res.status(400).render("order_detail", { order, error, campuses: CAMPUSES, campusLabels: CAMPUS_LABELS });

  if (order.status !== "PENDING") {
    return renderError("この取引は既に確定または取消されています");
  }

  const campus = req.body.campus;
  const meetupDetail = req.body.meetupDetail || null;
  const meetupAt = req.body.meetupAt ? new Date(req.body.meetupAt) : null;

  if (!campus || !isAllowedCampus(campus)) {
    return renderError("待ち合わせキャンパスを選択してください");
  }
  if (req.body.meetupAt && (!meetupAt || Number.isNaN(meetupAt.getTime()))) {
    return renderError("日時の形式が正しくありません");
  }

  await prisma.order.update({
    where: { id },
    data: { campus, meetupDetail, meetupAt },
  });

  res.redirect(`/orders/${id}`);
});

app.post("/orders/:id/confirm", requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  const userId = res.locals.currentUser.id;
  const order = await loadOrderForUser(id, userId);
  if (!order) {
    return res.status(404).send("Not Found");
  }
  if (order.status !== "PENDING") {
    return res
      .status(400)
      .render("order_detail", { order, error: "この取引は既に確定または取消されています", campuses: CAMPUSES, campusLabels: CAMPUS_LABELS });
  }

  const isBuyer = order.buyerId === userId;

  await prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id },
      data: isBuyer ? { buyerConfirmedAt: new Date() } : { sellerConfirmedAt: new Date() },
    });

    if (updated.buyerConfirmedAt && updated.sellerConfirmedAt) {
      await tx.order.update({ where: { id }, data: { status: "COMPLETED" } });
      await tx.listing.update({ where: { id: updated.listingId }, data: { status: "SOLD" } });
    }
  });

  res.redirect(`/orders/${id}`);
});

app.post("/orders/:id/cancel", requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  const order = await loadOrderForUser(id, res.locals.currentUser.id);
  if (!order) {
    return res.status(404).send("Not Found");
  }
  if (order.status !== "PENDING") {
    return res
      .status(400)
      .render("order_detail", { order, error: "この取引は既に確定または取消されています", campuses: CAMPUSES, campusLabels: CAMPUS_LABELS });
  }

  // 1 Listing : 生涯1 Order の制約と再利用は両立しないため、Listingは復帰させずCANCELLEDのまま終端する。
  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id }, data: { status: "CANCELLED" } });
    await tx.listing.update({ where: { id: order.listingId }, data: { status: "CANCELLED" } });
  });

  res.redirect(`/orders/${id}`);
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
