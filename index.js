import http from "node:http";

// Renderなどの本番環境では環境変数 PORT が指定されるので、それを使うようにする
const PORT = process.env.PORT || 8888;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // ブラウザで日本語が文字化けしないよう charset=utf-8 を指定する
  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  if (url.pathname === "/") {
    console.log("GET /");
    res.writeHead(200);
    res.end("こんにちは！");
  } else if (url.pathname === "/ask") {
    console.log("GET /ask");
    // URLの ?q=... の部分を読み取る
    const q = url.searchParams.get("q") ?? "質問がありません";
    res.writeHead(200);
    res.end(`お主の質問は '${q}' じゃな。`);
  } else {
    res.writeHead(404);
    res.end("ページが見つかりませぬ");
  }
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
