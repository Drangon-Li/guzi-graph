const { timingSafeEqual } = require("node:crypto");
const { once } = require("node:events");
const { MAX_MESSAGE_BYTES } = require("./plugins.cjs");

function authorize(req, { port, token }) {
  if (
    !["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(req.socket.remoteAddress)
  )
    return 403;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host))
    return 403;
  if (
    req.headers.origin !== undefined &&
    ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(
      req.headers.origin,
    )
  )
    return 403;
  const authorization = req.headers.authorization;
  const supplied = Buffer.from(
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "",
  );
  const expected = Buffer.from(token);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return 401;
  return null;
}

function respond(res, status, message) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Connection: "close",
    ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
  });
  res.end(JSON.stringify({ error: message }));
}

function readBody(req, res, timeout) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      respond(res, 408, "Request body timed out");
      chunks = [];
      finish(null);
      req.resume();
    }, timeout);
    timer.unref?.();
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_MESSAGE_BYTES) {
        respond(res, 413, "Request body too large");
        chunks = [];
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks)));
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.on("aborted", () => finish(null));
  });
}

function createRequestListener({ port, token, handle, bodyTimeout = 10000 }) {
  return async (req, res) => {
    const denied = authorize(req, { port, token });
    if (denied) {
      req.resume();
      return respond(
        res,
        denied,
        denied === 401 ? "Authentication required" : "Forbidden",
      );
    }
    // Reject absolute-form URLs as well as all routes outside the one MCP endpoint.
    if (req.url !== "/mcp") {
      req.resume();
      return respond(res, 404, "Not found");
    }
    if (!["POST", "GET", "DELETE"].includes(req.method)) {
      req.resume();
      return respond(res, 405, "Method not allowed");
    }
    if (Number(req.headers["content-length"]) > MAX_MESSAGE_BYTES) {
      req.resume();
      return respond(res, 413, "Request body too large");
    }
    if (
      req.method === "POST" &&
      !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")
    ) {
      req.resume();
      return respond(res, 415, "Expected application/json");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on("close", abort);
    try {
      const body = await readBody(req, res, bodyTimeout);
      if (body === null || res.destroyed) return;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const request = new Request(`http://127.0.0.1:${port}/mcp`, {
        method: req.method,
        headers,
        signal: controller.signal,
        ...(req.method === "POST" ? { body } : {}),
      });
      const response = await handle(request);
      if (res.destroyed) return;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value)))
              await once(res, "drain", { signal: controller.signal });
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      res.end();
    } catch {
      if (!res.headersSent && !res.destroyed)
        respond(res, 500, "MCP request failed");
      else res.destroy();
    } finally {
      res.removeListener("close", abort);
    }
  };
}

module.exports = { authorize, createRequestListener };
