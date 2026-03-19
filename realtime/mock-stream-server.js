const { WebSocketServer } = require("ws");

const PORT = Number(process.env.ZEN_WS_PORT || 8890);
const server = new WebSocketServer({ port: PORT });

const kinds = [
  "model-usage",
  "gpu-compute",
  "api-credit",
  "deployment-status",
  "agent-health",
  "revenue"
];

function makeEvent() {
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  const delta = Number((Math.random() * 12 - 6).toFixed(2));
  return JSON.stringify({
    kind,
    delta,
    timestamp: new Date().toISOString()
  });
}

setInterval(() => {
  const message = makeEvent();
  for (const client of server.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}, 2000);

console.log(`ZEN realtime stream active on ws://127.0.0.1:${PORT}`);
