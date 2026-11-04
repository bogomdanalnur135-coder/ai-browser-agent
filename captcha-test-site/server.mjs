import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(currentDir, "public");
const port = 3000;

const server = http.createServer((req, res) => {
  const filePath = path.join(publicDir, "index.html");

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Не удалось загрузить тестовый сайт");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`CAPTCHA test site: http://127.0.0.1:${port}`);
});
