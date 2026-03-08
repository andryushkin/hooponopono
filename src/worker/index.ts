import { HoopRoom } from './hoop-room.ts';
import type { Env } from './hoop-room.ts';

export { HoopRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const ASSETS = (env as unknown as { ASSETS: Fetcher }).ASSETS;

    if (url.hostname === 'www.hooponopono.online') {
      url.hostname = 'hooponopono.online';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/ws') {
      const id = env.HOOP_ROOM.idFromName('global');
      const stub = env.HOOP_ROOM.get(id);
      return stub.fetch(request);
    }

    // Stats dashboard — serve stats.html
    if (env.STATS_SECRET && url.pathname === `/stats/${env.STATS_SECRET}`) {
      return ASSETS.fetch(new Request(new URL('/stats.html', url.origin), request));
    }

    // Stats JSON API — proxy to DO
    if (env.STATS_SECRET && url.pathname === `/stats/${env.STATS_SECRET}/api`) {
      const id = env.HOOP_ROOM.idFromName('global');
      const stub = env.HOOP_ROOM.get(id);
      return stub.fetch(new Request(new URL(`/stats${url.search}`, url.origin), request));
    }

    // Pass through to Pages static assets
    return ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
