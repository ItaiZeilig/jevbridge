// Film one browser tab at a steady rate through the PawBrowse extension (dev "peek" command):
// JPEG frames with capture timestamps, no tab adoption, nothing else touched. Used to record
// side-by-side benchmarks of different tools driving the same Chrome.
//
//   node scripts/demo/peek-record.mjs <tabId> <out-dir> [fps=5]      (stop with SIGINT/SIGTERM)
import fs from 'node:fs';
import path from 'node:path';
import { startServer, initialize } from '../../test/helpers.mjs';

const [tabId, outDir, fpsArg] = process.argv.slice(2);
const fps = Number(fpsArg) || 5;
fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });
const srv = startServer({ PAWBROWSE_DEV_TOOLS: '1' });
await initialize(srv);
let id = 10, n = 0, stop = false;
const frames = [];
const call = async (args) => { const i = ++id; srv.rpc({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'browser_peek', arguments: args } }); return (await srv.waitFor(i, 10000)).result; };
const finish = async () => { if (stop) return; stop = true; };
process.on('SIGINT', finish); process.on('SIGTERM', finish);
const tick = 1000 / fps;
while (!stop) {
  const t0 = Date.now();
  try {
    const r = await call({ tabId: Number(tabId), quality: 60 });
    if (r && !r.isError) {
      const v = JSON.parse(r.content[0].text);
      const f = `${String(n++).padStart(5, '0')}.jpg`;
      fs.writeFileSync(path.join(outDir, 'frames', f), Buffer.from(v.data, 'base64'));
      frames.push({ file: f, t: v.t, url: v.url });
      fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(frames));
    } else if (r) { fs.appendFileSync(path.join(outDir, 'errors.log'), (r.content?.[0]?.text || 'error') + '\n'); }
  } catch (e) { fs.appendFileSync(path.join(outDir, 'errors.log'), String(e.message) + '\n'); }
  const wait = tick - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
await call({ end: true }).catch(() => {});
srv.kill();
