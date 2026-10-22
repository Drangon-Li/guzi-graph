const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { createRequestListener } = require("./mcp-http.cjs");

async function fixture(t) {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const calls = [];
  server.on(
    "request",
    createRequestListener({
      port,
      token: "private-token",
      bodyTimeout: 100,
      handle: async (request) => {
        calls.push({ method: request.method, body: await request.text() });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    }),
  );
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const request = (options = {}, body = "{}") =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          ...options,
          headers: {
            authorization: "Bearer private-token",
            "content-type": "application/json",
            ...options.headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode, data, headers: res.headers }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  return { port, calls, request };
}

test("only authenticated loopback requests with matching Host and Origin reach MCP", async (t) => {
  const { port, calls, request } = await fixture(t);
  assert.equal((await request()).status, 200);
  assert.equal(
    (await request({ headers: { authorization: "Bearer wrong" } })).status,
    401,
  );
  assert.equal(
    (await request({ headers: { host: `attacker.test:${port}` } })).status,
    403,
  );
  assert.equal(
    (await request({ headers: { host: "127.0.0.1:1" } })).status,
    403,
  );
  assert.equal(
    (await request({ headers: { origin: "https://attacker.test" } })).status,
    403,
  );
  assert.equal((await request({ headers: { origin: "null" } })).status, 403);
  assert.equal(
    (await request({ headers: { origin: `http://localhost:${port}` } })).status,
    200,
  );
  assert.equal(calls.length, 2);
});

test("route, method, content type and body size limits reject before dispatch", async (t) => {
  const { calls, request } = await fixture(t);
  assert.equal((await request({ path: "/other" })).status, 404);
  assert.equal(
    (await request({ path: "http://attacker.test/mcp" })).status,
    404,
  );
  assert.equal((await request({ method: "PUT" })).status, 405);
  assert.equal(
    (await request({ headers: { "content-type": "text/plain" } })).status,
    415,
  );
  assert.equal(
    (await request({ headers: { "content-length": "3000000" } }, "")).status,
    413,
  );
  assert.equal(
    (
      await request(
        { headers: { "transfer-encoding": "chunked" } },
        "x".repeat(2 * 1024 * 1024 + 1),
      )
    ).status,
    413,
  );
  assert.equal(calls.length, 0);
});
