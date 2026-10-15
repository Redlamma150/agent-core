import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";

export interface CoreEvent {
  type: string;
  data: unknown;
}

/** In-process bus; M3 publishes task state changes here and /events relays them to clients. */
export class EventBus {
  private emitter = new EventEmitter();

  publish(event: CoreEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(fn: (e: CoreEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}

const HEARTBEAT_MS = 25_000;

export function registerEvents(app: FastifyInstance, bus: EventBus): void {
  // One hook for all streams (registered once, not per connection, so reconnecting phones do not pile up hooks).
  // preClose runs before the server waits for connections to end; onClose would come too late and shutdown would hang.
  const open = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const close of [...open]) close();
  });

  app.get("/events", (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const unsubscribe = bus.subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(close);
    };
    // Fastify does not end hijacked streams on its own, so the shared hook ends each one.
    const close = () => {
      cleanup();
      res.end();
    };
    open.add(close);
    request.raw.on("close", cleanup);
  });
}
