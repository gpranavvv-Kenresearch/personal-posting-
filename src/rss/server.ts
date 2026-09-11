import http from 'http';
import { getRecentReportsForFeed } from '../sheets/sheets.js';
import { buildRssXml } from './feedBuilder.js';

const DEFAULT_PORT = 8090;

/**
 * Serves GET /feed.xml, rebuilt fresh from the sheet on every request (cheap
 * enough — one Sheets API read, no caching needed at this volume). Runs
 * alongside the cron daemon so `npm run dev`/`dev:supervised` keeps it alive.
 *
 * NOTE: this only binds a local port. For search engines to actually poll
 * it, the port needs to be reachable from the public internet — either this
 * process runs on a server with a public IP/reverse proxy, or something
 * (nginx, Cloudflare Tunnel, etc.) forwards a real domain to it.
 */
export function startRssServer(port: number = Number(process.env.RSS_PORT) || DEFAULT_PORT): void {
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/feed.xml') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found. Try /feed.xml');
      return;
    }
    try {
      const items = await getRecentReportsForFeed(50);
      const xml = buildRssXml(items);
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      res.end(xml);
    } catch (err: any) {
      console.error(`[RSS] Failed to build feed: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to build feed');
    }
  });

  server.listen(port, () => {
    console.log(`[RSS] Feed server listening on http://localhost:${port}/feed.xml`);
  });
}
