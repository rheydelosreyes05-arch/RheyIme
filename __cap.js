const fs = require("fs");
const outDir = "C:/Users/ACER/Videos/RheyIme/__frames";
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

async function main() {
  const res = await fetch("http://127.0.0.1:9222/json/new?http://localhost:3000/", { method: "PUT" });
  const tab = await res.json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((r) => {
    const m = ++id;
    pending.set(m, r);
    ws.send(JSON.stringify({ id: m, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await new Promise((r) => (ws.onopen = r));
  await send("Page.enable");

  const t0 = Date.now();
  let frame = 0;
  const events = [];
  const timer = setInterval(async () => {
    const n = frame++;
    try {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(`${outDir}/f${String(n).padStart(2, "0")}_${Date.now() - t0}.png`, Buffer.from(shot.data, "base64"));
    } catch (e) { events.push(String(e)); }
    if (Date.now() - t0 > 5000) {
      clearInterval(timer);
      try {
        const r = await send("Runtime.evaluate", {
          expression: `JSON.stringify({paints: performance.getEntriesByType("paint").map(p=>[p.name,Math.round(p.startTime)]), nav: Math.round(performance.timing.domContentLoadedEventEnd-performance.timing.navigationStart), load: Math.round(performance.timing.loadEventEnd-performance.timing.navigationStart), imgs: performance.getEntriesByType("resource").filter(r=>/envelope|background/.test(r.name)).map(r=>[r.name.split("/").pop(), Math.round(r.startTime), Math.round(r.responseEnd)])})`,
          returnByValue: true
        });
        events.push(r.result.value);
      } catch (e) { events.push(String(e)); }
      console.log(events.join("\n"));
      ws.close();
      process.exit(0);
    }
  }, 100);
}
main().catch((e) => { console.error(e); process.exit(1); });