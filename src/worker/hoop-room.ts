export interface Env {
  HOOP_ROOM: DurableObjectNamespace;
  STATS_SECRET?: string;
}

interface StatsResponse {
  period: string;
  total_sessions: number;
  today_sessions: number;
  avg_duration_seconds: number;
  unique_clients: number;
  unique_clients_total: number;
  new_clients_today: number;
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
        id        TEXT PRIMARY KEY,
        started   INTEGER NOT NULL,
        duration  INTEGER DEFAULT 0,
        locale    TEXT NOT NULL DEFAULT 'en',
        source    TEXT NOT NULL DEFAULT 'web',
        device    TEXT NOT NULL DEFAULT 'desktop'
      )
    `);
    this.state.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started)
    `);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        id         TEXT PRIMARY KEY,
        first_seen INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL,
        locale     TEXT NOT NULL DEFAULT 'en',
        source     TEXT NOT NULL DEFAULT 'web',
        device     TEXT NOT NULL DEFAULT 'desktop'
      )
    `);
    try {
      this.state.storage.sql.exec(
        `ALTER TABLE sessions ADD COLUMN client_id TEXT DEFAULT ''`,
      );
    } catch (_) {
      // column already exists — migration already ran
    }
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
    const cid = url.searchParams.get('cid') ?? '';

    const sid = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    // UPSERT client record
    if (cid) {
      this.state.storage.sql.exec(
        `INSERT INTO clients (id, first_seen, last_seen, locale, source, device)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_seen = excluded.last_seen,
           locale    = excluded.locale,
           source    = excluded.source,
           device    = excluded.device`,
        cid, now, now, lang, src, device,
      );
    }

    // Insert session record
    this.state.storage.sql.exec(
      `INSERT INTO sessions (id, started, locale, source, device, client_id) VALUES (?, ?, ?, ?, ?, ?)`,
      sid, now, lang, src, device, cid,
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
    const periodParam = url.searchParams.get('period') ?? '30d';
    const now = Math.floor(Date.now() / 1000);
    const todayStart = now - (now % 86400);

    const periodDays: Record<string, number | null> = {
      '1d': 1, '7d': 7, '30d': 30, '90d': 90, 'all': null,
    };
    const days = periodDays[periodParam] ?? 30;
    const periodStart = days !== null ? now - days * 86400 : 0;

    // Build WHERE for sessions with period + source
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (sourceFilter) { conditions.push('source = ?'); params.push(sourceFilter); }
    if (days !== null) { conditions.push('started >= ?'); params.push(periodStart); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Total sessions in period
    const totalRow = this.state.storage.sql.exec(
      `SELECT COUNT(*) as cnt FROM sessions ${where}`,
      ...params,
    ).one() as { cnt: number };

    // Today sessions (always 1 day, regardless of period)
    const todayParams: unknown[] = sourceFilter ? [sourceFilter, todayStart] : [todayStart];
    const todayWhere = sourceFilter
      ? 'WHERE source = ? AND started >= ?'
      : 'WHERE started >= ?';
    const todayRow = this.state.storage.sql.exec(
      `SELECT COUNT(*) as cnt FROM sessions ${todayWhere}`,
      ...todayParams,
    ).one() as { cnt: number };

    // Avg duration (period, only completed sessions)
    const avgWhere = conditions.length
      ? 'WHERE ' + [...conditions, 'duration > 0'].join(' AND ')
      : 'WHERE duration > 0';
    const avgRow = this.state.storage.sql.exec(
      `SELECT COALESCE(AVG(duration), 0) as avg_dur FROM sessions ${avgWhere}`,
      ...params,
    ).one() as { avg_dur: number };

    // Unique clients in period (from sessions.client_id)
    const uqPeriodWhere = conditions.length
      ? 'WHERE ' + [...conditions, "client_id != ''"].join(' AND ')
      : "WHERE client_id != ''";
    const uqPeriodRow = this.state.storage.sql.exec(
      `SELECT COUNT(DISTINCT client_id) as cnt FROM sessions ${uqPeriodWhere}`,
      ...params,
    ).one() as { cnt: number };

    // Unique clients total (all time, from clients table)
    const uqTotalRow = sourceFilter
      ? this.state.storage.sql.exec(
          `SELECT COUNT(DISTINCT client_id) as cnt FROM sessions WHERE source = ? AND client_id != ''`,
          sourceFilter,
        ).one() as { cnt: number }
      : this.state.storage.sql.exec(
          `SELECT COUNT(*) as cnt FROM clients`,
        ).one() as { cnt: number };

    // New clients today
    const newTodayRow = sourceFilter
      ? this.state.storage.sql.exec(
          `SELECT COUNT(*) as cnt FROM clients WHERE source = ? AND first_seen >= ?`,
          sourceFilter, todayStart,
        ).one() as { cnt: number }
      : this.state.storage.sql.exec(
          `SELECT COUNT(*) as cnt FROM clients WHERE first_seen >= ?`,
          todayStart,
        ).one() as { cnt: number };

    // Sessions per day (cap at 90 days for graph when period=all)
    const graphStart = days !== null ? periodStart : now - 90 * 86400;
    const perDayParams: unknown[] = sourceFilter ? [sourceFilter, graphStart] : [graphStart];
    const perDayWhere = sourceFilter
      ? 'WHERE source = ? AND started >= ?'
      : 'WHERE started >= ?';
    const perDayRows = this.state.storage.sql.exec(
      `SELECT date(started, 'unixepoch') as day, COUNT(*) as cnt FROM sessions ${perDayWhere} GROUP BY day ORDER BY day`,
      ...perDayParams,
    ).toArray() as { day: string; cnt: number }[];

    // Locale distribution
    const localeRows = this.state.storage.sql.exec(
      `SELECT locale, COUNT(*) as cnt FROM sessions ${where} GROUP BY locale ORDER BY cnt DESC`,
      ...params,
    ).toArray() as { locale: string; cnt: number }[];

    // Source distribution
    const sourceRows = this.state.storage.sql.exec(
      `SELECT source, COUNT(*) as cnt FROM sessions ${where} GROUP BY source ORDER BY cnt DESC`,
      ...params,
    ).toArray() as { source: string; cnt: number }[];

    // Device distribution
    const deviceRows = this.state.storage.sql.exec(
      `SELECT device, COUNT(*) as cnt FROM sessions ${where} GROUP BY device ORDER BY cnt DESC`,
      ...params,
    ).toArray() as { device: string; cnt: number }[];

    // Peak hours
    const hourRows = this.state.storage.sql.exec(
      `SELECT CAST(strftime('%H', started, 'unixepoch') AS INTEGER) as hour, COUNT(*) as cnt FROM sessions ${where} GROUP BY hour ORDER BY hour`,
      ...params,
    ).toArray() as { hour: number; cnt: number }[];

    const stats: StatsResponse = {
      period: periodParam,
      total_sessions: totalRow.cnt,
      today_sessions: todayRow.cnt,
      avg_duration_seconds: Math.round(avgRow.avg_dur),
      unique_clients: uqPeriodRow.cnt,
      unique_clients_total: uqTotalRow.cnt,
      new_clients_today: newTodayRow.cnt,
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
