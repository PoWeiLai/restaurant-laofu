// 極簡 SSE 推播中心：廚房 / 後台 / 客人端訂閱後即時收到訂單變化
const clients = new Set();

export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const client = { res };
  clients.add(client);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

export function broadcast(type, payload = {}) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) {
    try {
      c.res.write(data);
    } catch {
      clients.delete(c);
    }
  }
}
