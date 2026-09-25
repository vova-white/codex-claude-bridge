import { timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";

/** Incremented whenever the MCP entry point and the service stop understanding each other. */
export const PROTOCOL_VERSION = 1;

interface Request {
  id: number;
  method: string;
  params?: unknown;
}

interface Response {
  id: number;
  result?: unknown;
  error?: { code: string; message: string };
}

/** An error reported to the caller with a stable code. */
export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function readLines(socket: Socket, onLine: (value: unknown) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        socket.destroy();
        return;
      }
    }
  });
}

function write(socket: Socket, message: Response | Request): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

export type Handler = (params: unknown) => Promise<unknown>;

/**
 * Serves newline-delimited JSON requests on a local socket. Each connection must
 * first present the service token; nothing else is answered before that.
 */
export function serve(
  socketPath: string,
  token: string,
  welcome: unknown,
  handlers: Record<string, Handler>,
  onError: (error: unknown) => void,
): Promise<Server> {
  const expected = Buffer.from(token);
  const server = createServer((socket) => {
    let authenticated = false;
    socket.on("error", () => socket.destroy());
    readLines(socket, (value) => {
      const request = value as Request;
      if (!authenticated) {
        const params = (request.params ?? {}) as { token?: unknown; protocol?: unknown };
        const presented = Buffer.from(typeof params.token === "string" ? params.token : "");
        if (
          request.method !== "hello" ||
          presented.length !== expected.length ||
          !timingSafeEqual(presented, expected)
        ) {
          write(socket, {
            id: request.id,
            error: { code: "unauthorized", message: "Invalid service token." },
          });
          socket.end();
          return;
        }
        if (params.protocol !== PROTOCOL_VERSION) {
          write(socket, {
            id: request.id,
            error: {
              code: "protocol_mismatch",
              message: `The running bridge service speaks protocol ${PROTOCOL_VERSION}; stop it so that the installed version can start.`,
            },
          });
          socket.end();
          return;
        }
        authenticated = true;
        write(socket, { id: request.id, result: welcome });
        return;
      }
      const handler = handlers[request.method];
      if (!handler) {
        write(socket, {
          id: request.id,
          error: { code: "unknown_method", message: `Unknown method ${request.method}.` },
        });
        return;
      }
      handler(request.params).then(
        (result) => write(socket, { id: request.id, result: result ?? null }),
        (error: unknown) => {
          if (!(error instanceof ServiceError)) onError(error);
          const code = error instanceof ServiceError ? error.code : "internal";
          const message = error instanceof Error ? error.message : String(error);
          write(socket, { id: request.id, error: { code, message } });
        },
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** An authenticated connection from an MCP entry point to the service. */
export class ServiceConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  closed = false;

  private readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
    readLines(socket, (value) => {
      const response = value as Response;
      const waiter = this.pending.get(response.id);
      if (!waiter) return;
      this.pending.delete(response.id);
      if (response.error)
        waiter.reject(new ServiceError(response.error.code, response.error.message));
      else waiter.resolve(response.result);
    });
    const fail = () => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        waiter.reject(
          new ServiceError("service_unavailable", "The bridge service connection closed."),
        );
      }
      this.pending.clear();
    };
    socket.on("close", fail);
    socket.on("error", fail);
  }

  static open(socketPath: string, token: string): Promise<ServiceConnection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        const connection = new ServiceConnection(socket);
        connection.request("hello", { token, protocol: PROTOCOL_VERSION }).then(
          () => resolve(connection),
          (error: unknown) => {
            socket.destroy();
            reject(error);
          },
        );
      });
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new ServiceError("service_unavailable", "The bridge service connection closed."),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      write(this.socket, { id, method, params });
    });
  }

  close(): void {
    this.socket.end();
  }
}
