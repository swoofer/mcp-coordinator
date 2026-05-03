FROM node:22-slim
WORKDIR /app
COPY dashboard/public/ public/
RUN cat > server.mjs << 'SCRIPT'
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";

const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };

createServer((req, res) => {
  const filePath = join("public", req.url === "/" ? "index.html" : req.url);
  if (!existsSync(filePath)) { res.writeHead(200, {"Content-Type":"text/html"}); res.end(readFileSync("public/index.html","utf-8")); return; }
  const ext = extname(filePath);
  res.writeHead(200, {"Content-Type": MIME[ext] || "text/plain"});
  res.end(readFileSync(filePath));
}).listen(3200, () => console.log("Dashboard on :3200"));
SCRIPT
CMD ["node", "server.mjs"]
