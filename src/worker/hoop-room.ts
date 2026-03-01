export interface Env {
  HOOP_ROOM: DurableObjectNamespace;
}

export class HoopRoom implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.state.acceptWebSocket(server);
    this.broadcastCount();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // clients don't send messages
  }

  webSocketClose(_ws: WebSocket): void {
    this.broadcastCount();
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
    this.broadcastCount();
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
}
