export interface Env {
  HOOP_ROOM: DurableObjectNamespace;
  STATS_SECRET?: string;
}

interface SessionRow {
  id: string;
  started: number;
  duration: number;
  locale: string;
  source: string;
  device: string;
}

interface StatsResponse {
  period: string;
  total_sessions: number;
  today_sessions: number;
  avg_duration_seconds: number;
  sessions_per_day: { day: string; count: number }[];
  locale_distribution: { locale: string; count: number }[];
  source_distribution: { source: string; count: number }[];
  device_distribution: { device: string; count: number }[];
  peak_hours: { hour: number; count: number }[];
}

export class HoopRoom implements DurableObject {
  private lastCleanup = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private ensureSchema(): void {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id       TEXT PRIMARY KEY,
        started  INTEGER NOT NULL,
        duration INTEGER DEFAULT 0,
        locale   TEXT NOT NULL DEFAULT 'en',
        source   TEXT NOT NULL DEFAULT 'web',
        device   TEXT NOT NULL DEFAULT 'desktop'
      )
    `);
    this.state.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started)
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Stats API (non-WebSocket)
    if (url.pathname === '/stats') {
      return this.handleStats(url);
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    this.ensureSchema();

    // Parse session metadata from query params
    const lang = url.searchParams.get('lang') || 'en';
    const src = url.searchParams.get('src') || 'web';
    const device = url.searchParams.get('device') || 'desktop';

    const sid = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    // Insert session record
    this.state.storage.sql.exec(
      `INSERT INTO sessions (id, started, locale, source, device) VALUES (?, ?, ?, ?, ?)`,
      sid, now, lang, src, device,
    );

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Store session id and start time as tags for retrieval on close
    this.state.acceptWebSocket(server, [sid, String(now)]);
    this.broadcastCount();

    // Periodic cleanup
    this.maybeCleanup(now);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // clients don't send messages
  }

  webSocketClose(ws: WebSocket): void {
    this.finalizeSession(ws);
    this.broadcastCount();
  }

  webSocketError(ws: WebSocket): void {
    this.finalizeSession(ws);
    this.broadcastCount();
  }

  private finalizeSession(ws: WebSocket): void {
    try {
      const tags = this.state.getTags(ws);
      if (tags.length < 2) return;
      const sid = tags[0]!;
      const started = parseInt(tags[1]!, 10);
      const duration = Math.max(0, Math.floor(Date.now() / 1000) - started);
      this.state.storage.sql.exec(
        `UPDATE sessions SET duration = ? WHERE id = ?`,
        duration, sid,
      );
    } catch {
      // socket already gone
    }
  }

  private broadcastCount(): void {
    const sockets = this.state.getWebSockets();
    const count = sockets.length;
    const msg = JSON.stringify({ type: 'online_count', count });
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {
        // client already disconnected
      }
    }
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanup < 3600) return;
    this.lastCleanup = now;
    const cutoff = now - 90 * 24 * 3600;
    this.state.storage.sql.exec(
      `DELETE FROM sessions WHERE started < ?`,
      cutoff,
    );
  }

  private handleStats(url: URL): Response {
    this.ensureSchema();

    const sourceFilter = url.searchParams.get('source');
    const whereClause = sourceFilter ? `WHERE source = ?` : '';
    const params: unknown[] = sourceFilter ? [sourceFilter] : [];

    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 24 * 3600;
    const todayStart = now - (now % 86400);

    // Total sessions (last 30 days)
    const totalRow = this.state.storage.sql.exec(
      `SELECT COUNT(*) as cnt FROM sessions ${whereClause ? whereClause + ' AND' : 'WHERE'} started >= ?`,
      ...params, thirtyDaysAgo,
    ).one() as { cnt: number };

    // Today sessions
    const todayRow = this.state.storage.sql.exec(
      `SELECT COUNT(*) as cnt FROM sessions ${whereClause ? whereClause + ' AND' : 'WHERE'} started >= ?`,
      ...params, todayStart,
    ).one() as { cnt: number };

    // Avg duration (last 30 days, only completed sessions with duration > 0)
    const avgRow = this.state.storage.sql.exec(
      `SELECT COALESCE(AVG(duration), 0) as avg_dur FROM sessions ${whereClause ? whereClause + ' AND' : 'WHERE'} started >= ? AND duration > 0`,
      ...params, thirtyDaysAgo,
    ).one() as { avg_dur: number };

    // Sessions per day (last 30 days)
    const perDayRows = this.state.storage.sql.exec(
      `SELECT date(started, 'unixepoch') as day, COUNT(*) as cnt FROM sessions ${whereClause ? whereClause + ' AND' : 'WHERE'} started >= ? GROUP BY day ORDER BY day`,
      ...params, thirtyDaysAgo,
    ).toArray() as { day: string; cnt: number }[];

    // Locale distribution
    const localeRows = this.state.storage.sql.exec(
      `SELECT locale, COUNT(*) as cnt FROM sessions ${whereClause ? whereClause + ' AND' : 'WHERE'} started >= ? GROUP BY locale ORDER BY cnt DESC`,
      ...params, thirtyDaysAgo,
    ).toArray() as { locale: string; cnt: number }[];

    // Source distribution
    const sourceRows = this.state.storage.sql.exec(
      `SELECT source, COUNT(*) as cnt FROM sessions ${whereClause ? whereClause + ' AND' : 'WHERE'} started >= ? GROUP BY source ORDER BY cnt DESC`,
      ...params, thirtyDaysAgo,
    ).toArray() as { source: string; cnt: number }[];

    // Device distribution
    const deviceRows = this.state.storage.sql.exec(
      `SELECT device, COUNT(*) as cnt FROM sessions ${whereClause ? whereClause + ' AND' : 'WHERE'} started >= ? GROUP BY device ORDER BY cnt DESC`,
      ...params, thirtyDaysAgo,
    ).toArray() as { device: string; cnt: number }[];

    // Peak hours
    const hourRows = this.state.storage.sql.exec(
      `SELECT CAST(strftime('%H', started, 'unixepoch') AS INTEGER) as hour, COUNT(*) as cnt FROM sessions ${whereClause ? whereClause + ' AND' : 'WHERE'} started >= ? GROUP BY hour ORDER BY hour`,
      ...params, thirtyDaysAgo,
    ).toArray() as { hour: number; cnt: number }[];

    const stats: StatsResponse = {
      period: '30d',
      total_sessions: totalRow.cnt,
      today_sessions: todayRow.cnt,
      avg_duration_seconds: Math.round(avgRow.avg_dur),
      sessions_per_day: perDayRows.map(r => ({ day: r.day, count: r.cnt })),
      locale_distribution: localeRows.map(r => ({ locale: r.locale, count: r.cnt })),
      source_distribution: sourceRows.map(r => ({ source: r.source, count: r.cnt })),
      device_distribution: deviceRows.map(r => ({ device: r.device, count: r.cnt })),
      peak_hours: hourRows.map(r => ({ hour: r.hour, count: r.cnt })),
    };

    return new Response(JSON.stringify(stats), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
