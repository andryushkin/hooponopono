import { HoopRoom } from './hoop-room.ts';
import type { Env } from './hoop-room.ts';

export { HoopRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === 'www.hooponopono.online') {
      url.hostname = 'hooponopono.online';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/ws') {
      const id = env.HOOP_ROOM.idFromName('global');
      const stub = env.HOOP_ROOM.get(id);
      return stub.fetch(request);
    }

    // Pass through to Pages static assets
    return (env as unknown as { ASSETS: Fetcher }).ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
