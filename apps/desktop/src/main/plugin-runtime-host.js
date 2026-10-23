/* eslint-env es2020 */
(() => {
  const ownerDocument = document.currentScript.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const bridge = ownerWindow.pluginRuntimeHost;
  const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
  let worker = null;
  let workerUrl = null;

  function workerBootstrap(execute, configuration) {
    const send = globalThis.postMessage.bind(globalThis);
    const handlers = new Map();
    const pending = new Map();
    const commands = new Set(configuration.commands);
    const maxBytes = 2 * 1024 * 1024;
    const encoder = new TextEncoder();
    let sequence = 0;
    let registering = true;
    let running = false;

    const errorMessage = (error) =>
      String(error?.message || error || "Plugin failed").slice(0, 1000);
    const errorDetails = (error) => ({
      message: errorMessage(error),
      ...(typeof error?.code === "string"
        ? { code: error.code.slice(0, 128) }
        : {}),
    });
    const errorFromDetails = (details) => {
      const error = new Error(errorMessage(details));
      if (typeof details?.code === "string") {
        error.code = details.code.slice(0, 128);
      }
      return error;
    };
    const checkedValue = (value) => {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        if (value === undefined) {
          return undefined;
        }
        throw new Error("Plugin messages must contain JSON values");
      }
      if (encoder.encode(serialized).byteLength > maxBytes) {
        throw new Error("Plugin message exceeds 2 MiB");
      }
      return JSON.parse(serialized);
    };
    const request = (command, args = {}) => {
      if (typeof command !== "string" || !command || command.length > 128) {
        return Promise.reject(new Error("Invalid plugin API command"));
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return Promise.reject(
          new Error("Plugin API arguments must be an object"),
        );
      }
      if (pending.size >= 32) {
        return Promise.reject(new Error("Too many pending plugin requests"));
      }
      let message;
      const id = `call-${++sequence}`;
      try {
        message = checkedValue({ type: "call", id, command, arguments: args });
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send(message);
      });
    };
    const sdk = Object.freeze({
      registerCommand(id, handler) {
        if (!registering) {
          throw new Error("Plugin command registration is closed");
        }
        if (!commands.has(id)) {
          throw new Error("Undeclared plugin command");
        }
        if (handlers.has(id)) {
          throw new Error("Duplicate plugin command handler");
        }
        if (typeof handler !== "function") {
          throw new Error("Plugin command handler must be a function");
        }
        handlers.set(id, handler);
      },
      call: request,
      storage: Object.freeze({
        get: (key) => request("storage.get", { key }),
        set: (key, value) => request("storage.set", { key, value }),
      }),
    });
    Object.defineProperty(globalThis, "guzi", {
      value: sdk,
      configurable: false,
      writable: false,
    });
    for (const name of [
      "fetch",
      "WebSocket",
      "EventSource",
      "XMLHttpRequest",
      "WebTransport",
      "importScripts",
      "Worker",
      "SharedWorker",
      "BroadcastChannel",
      "indexedDB",
      "caches",
    ]) {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        configurable: false,
        writable: false,
      });
    }
    globalThis.addEventListener("message", async ({ data: message }) => {
      if (message.type === "call-result") {
        const call = pending.get(message.id);
        if (!call) {
          return;
        }
        pending.delete(message.id);
        if (message.error) {
          call.reject(errorFromDetails(message.error));
        } else {
          call.resolve(message.result);
        }
      } else if (message.type === "run") {
        const handler = handlers.get(message.commandId);
        if (registering || running || !handler) {
          send({
            type: "result",
            id: message.id,
            error: { message: "Invalid plugin command" },
          });
          return;
        }
        running = true;
        try {
          send(
            checkedValue({
              type: "result",
              id: message.id,
              result: await handler(message.arguments),
            }),
          );
        } catch (error) {
          send({ type: "result", id: message.id, error: errorDetails(error) });
        } finally {
          running = false;
        }
      }
    });
    globalThis.addEventListener("unhandledrejection", (event) => {
      event.preventDefault();
      send({ type: "fatal", error: errorDetails(event.reason) });
    });
    setInterval(
      () => send({ type: "heartbeat" }),
      configuration.heartbeatInterval,
    );
    Promise.resolve()
      .then(execute)
      .then(() => {
        registering = false;
        if (handlers.size !== commands.size) {
          throw new Error("Plugin did not register all declared commands");
        }
        send({ type: "ready", commands: [...handlers.keys()] });
      })
      .catch((error) => send({ type: "fatal", error: errorDetails(error) }));
  }

  const fatal = (error) => {
    worker?.terminate();
    worker = null;
    if (workerUrl) {
      ownerWindow.URL.revokeObjectURL(workerUrl);
    }
    workerUrl = null;
    bridge.send({
      type: "fatal",
      error: {
        message: String(
          error?.message || error || "Plugin worker failed",
        ).slice(0, 1000),
      },
    });
  };

  bridge.onMessage((message) => {
    if (message.type === "initialize") {
      if (worker) {
        return;
      }
      if (
        typeof message.source !== "string" ||
        new ownerWindow.TextEncoder().encode(message.source).byteLength >
          256 * 1024
      ) {
        fatal(new Error("Invalid plugin source"));
        return;
      }
      const configuration = JSON.stringify({
        commands: message.commands,
        heartbeatInterval: message.heartbeatInterval,
      });
      const source = `(${workerBootstrap.toString()})(async () => {\n${
        message.source
      }\n}, ${configuration});`;
      try {
        workerUrl = ownerWindow.URL.createObjectURL(
          new ownerWindow.Blob([source], { type: "text/javascript" }),
        );
        worker = new ownerWindow.Worker(workerUrl, {
          name: "guzi-user-plugin",
        });
        worker.addEventListener("message", ({ data }) => {
          try {
            const serialized = JSON.stringify(data);
            if (
              !serialized ||
              new ownerWindow.TextEncoder().encode(serialized).byteLength >
                MAX_MESSAGE_BYTES
            ) {
              throw new Error("Plugin message exceeds 2 MiB");
            }
            bridge.send(JSON.parse(serialized));
          } catch (error) {
            fatal(error);
          }
        });
        worker.addEventListener("error", (event) => {
          event.preventDefault();
          fatal(new Error(event.message || "Plugin worker failed"));
        });
        worker.addEventListener("messageerror", () =>
          fatal(new Error("Invalid plugin worker message")),
        );
      } catch (error) {
        fatal(error);
      }
    } else if (message.type === "run" || message.type === "call-result") {
      worker?.postMessage(message);
    }
  });
  bridge.send({ type: "host-ready" });
})();
