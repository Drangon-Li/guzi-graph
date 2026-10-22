const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const {
  Client,
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/client");
const {
  startService,
  toToolResult,
  toolSchemas,
} = require("./mcp-service.cjs");
const { COMMANDS } = require("./plugins.cjs");

const token = "f".repeat(64);
async function fixture(t, execute) {
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const service = await startService({ port, token, execute });
  t.after(() => service.close());
  const client = new Client({ name: "guzi-test-client", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    },
  );
  await client.connect(transport);
  t.after(() => client.close());
  return { client, port };
}

test("official Streamable HTTP client initializes, lists authorized tools, and receives structured results", async (t) => {
  const calls = [];
  const { client } = await fixture(t, async (command, args) => {
    calls.push({ command, args });
    return { result: { canvases: [], files: [] } };
  });
  const tools = await client.listTools();
  assert.deepEqual(new Set(tools.tools.map((tool) => tool.name)), COMMANDS);
  assert.equal(tools.tools.length, Object.keys(toolSchemas).length);
  const result = await client.callTool({
    name: "list_canvases",
    arguments: {},
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, { canvases: [], files: [] });
  assert.deepEqual(calls, [{ command: "list_canvases", args: {} }]);
});

test("MCP initialization and tool discovery expose the default hand-drawn style and explicit override policy", async (t) => {
  const { client } = await fixture(t, async () => ({ result: {} }));
  const instructions = client.getInstructions();
  const { tools } = await client.listTools();
  const description = tools.find(
    (tool) => tool.name === "apply_operations",
  ).description;

  for (const guidance of [instructions, description]) {
    assert.equal(typeof guidance, "string");
    assert.match(guidance, /hand-drawn style by default/);
    assert.match(guidance, /roughness:1/);
    assert.match(guidance, /fontFamily:5 \(Excalifont\)/);
    assert.match(
      guidance,
      /Only override this style when the user explicitly requests/,
    );
    assert.match(guidance, /patch preserves every style field that it omits/);
  }
});

test("MCP dispatch preserves omitted styles and allows explicit style overrides", async (t) => {
  const calls = [];
  const { client } = await fixture(t, async (command, args) => {
    calls.push({ command, args });
    return { result: { revision: 2 } };
  });
  const args = {
    documentId: "canvas",
    expectedRevision: 1,
    requestId: "styles",
    operations: [
      { type: "create", element: { type: "rectangle", x: 0, y: 0 } },
      {
        type: "create",
        element: {
          type: "rectangle",
          x: 100,
          y: 0,
          roughness: 0,
          label: { text: "Clean", fontFamily: 2 },
          roundness: null,
        },
      },
      { type: "patch", id: "existing", patch: { x: 20 } },
    ],
  };
  const result = await client.callTool({
    name: "apply_operations",
    arguments: args,
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, [{ command: "apply_operations", args }]);
});

test("MCP preserves legitimate empty rich-text paragraphs through request validation and dispatch", async (t) => {
  const calls = [];
  const { client } = await fixture(t, async (command, args) => {
    calls.push({ command, args });
    return { result: { revision: 2, operations: args.operations } };
  });
  const richText = {
    version: 1,
    paragraphs: [
      { runs: [{ text: "Before", bold: true }] },
      { runs: [] },
      { runs: [{ text: "After" }] },
    ],
  };
  const args = {
    documentId: "canvas",
    expectedRevision: 1,
    requestId: "empty-paragraph",
    operations: [
      {
        type: "create",
        element: { type: "text", x: 0, y: 0, richText },
      },
      {
        type: "create",
        element: {
          type: "table",
          x: 100,
          y: 0,
          rows: [100],
          columns: [200],
          cells: [{ row: 0, column: 0, richText }],
        },
      },
    ],
  };
  const result = await client.callTool({
    name: "apply_operations",
    arguments: args,
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, [{ command: "apply_operations", args }]);
  assert.deepEqual(result.structuredContent, {
    revision: 2,
    operations: args.operations,
  });
});

test("schema rejects oversized batches and unknown element types before workspace dispatch", async (t) => {
  const calls = [];
  const { client } = await fixture(t, async (command) => {
    calls.push(command);
    return { result: {} };
  });
  for (const arguments_ of [
    {
      documentId: "canvas",
      expectedRevision: 1,
      requestId: "r",
      operations: Array.from({ length: 501 }, () => ({
        type: "delete",
        id: "element",
      })),
    },
    {
      documentId: "canvas",
      expectedRevision: 1,
      requestId: "r",
      operations: [{ type: "create", element: { type: "iframe", x: 0, y: 0 } }],
    },
    {
      documentId: "canvas",
      expectedRevision: -1,
      requestId: "r",
      operations: [{ type: "delete", id: "element" }],
    },
  ]) {
    const result = await client.callTool({
      name: "apply_operations",
      arguments: arguments_,
    });
    assert.equal(result.isError, true);
  }
  assert.deepEqual(calls, []);
});

test("workspace conflicts and busy failures are MCP tool errors while the connection remains usable", async (t) => {
  const { client } = await fixture(t, async (command) =>
    command === "apply_operations"
      ? {
          error: {
            code: "REVISION_CONFLICT",
            message: "Read current revision before applying.",
          },
        }
      : { error: { code: "BUSY", message: "Workspace busy" } },
  );
  const result = await client.callTool({
    name: "apply_operations",
    arguments: {
      documentId: "canvas",
      expectedRevision: 1,
      requestId: "r",
      operations: [{ type: "delete", id: "element" }],
    },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "REVISION_CONFLICT");
  const next = await client.callTool({ name: "list_canvases", arguments: {} });
  assert.equal(next.isError, true);
  assert.equal(next.structuredContent.error.code, "BUSY");
});

test("PNG is image content and SVG is an embedded text resource without duplicating base64 in metadata", () => {
  const png = toToolResult({
    result: {
      documentId: "canvas",
      revision: 2,
      image: { data: "aW1hZ2U=", mimeType: "image/png" },
    },
  });
  assert.equal(png.content[0].type, "image");
  assert.equal(png.content[0].mimeType, "image/png");
  assert.deepEqual(png.structuredContent, {
    documentId: "canvas",
    revision: 2,
  });
  const source = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  const svg = toToolResult({
    result: {
      documentId: "canvas",
      image: {
        data: Buffer.from(source).toString("base64"),
        mimeType: "image/svg+xml",
      },
    },
  });
  assert.equal(svg.content[0].type, "resource");
  assert.equal(svg.content[0].resource.text, source);
  assert.equal(svg.content[0].resource.mimeType, "image/svg+xml");
  assert.equal(svg.structuredContent.image, undefined);
});

test("occupied service port fails with EADDRINUSE and does not claim readiness", async (t) => {
  const existing = http.createServer();
  existing.listen(0, "127.0.0.1");
  await once(existing, "listening");
  t.after(() => new Promise((resolve) => existing.close(resolve)));
  await assert.rejects(
    startService({
      port: existing.address().port,
      token,
      execute: async () => ({ result: {} }),
    }),
    { code: "EADDRINUSE" },
  );
});

test("presentation schemas dispatch every operation and retain scene targets", async (t) => {
  const calls = [];
  const { client } = await fixture(t, async (command, args) => {
    calls.push({ command, args });
    return { result: { documentId: "deck", revision: 4 } };
  });
  const requests = [
    ["get_capabilities", {}],
    ["create_presentation", { title: "Deck", sourceDocumentId: "canvas" }],
    ["read_presentation", { documentId: "deck" }],
    ...[
      { type: "add", title: "Slide", afterSlideId: "slide" },
      { type: "duplicate", slideId: "slide" },
      { type: "rename", slideId: "slide", title: "Renamed" },
      { type: "move", slideId: "slide", toIndex: 0 },
      { type: "delete", slideId: "slide" },
      { type: "select", slideId: "slide" },
      { type: "copy_from", sourceDocumentId: "other", sourceSlideId: "source" },
    ].map((operation, index) => [
      "update_presentation",
      {
        documentId: "deck",
        expectedRevision: 3,
        requestId: `request-${index}`,
        operation,
      },
    ]),
    [
      "control_presentation",
      { documentId: "deck", action: "goto", slideId: "slide" },
    ],
    ["export_presentation", { documentId: "deck", format: "pdf" }],
    ["save_presentation", { documentId: "deck" }],
    [
      "read_canvas",
      { documentId: "deck", slideId: "slide", subsceneId: "nested" },
    ],
    [
      "export_canvas",
      {
        documentId: "deck",
        slideId: "slide",
        subsceneId: "nested",
        format: "svg",
      },
    ],
  ];
  for (const [name, args] of requests) {
    assert.notEqual(
      (await client.callTool({ name, arguments: args })).isError,
      true,
    );
  }
  assert.deepEqual(
    calls,
    requests.map(([command, args]) => ({ command, args })),
  );
});

test("presentation schemas reject path grants, arbitrary actions and invalid revision before dispatch", async (t) => {
  const calls = [];
  const { client } = await fixture(t, async (command) => {
    calls.push(command);
    return { result: {} };
  });
  for (const [name, args] of [
    ["get_capabilities", { path: "/external" }],
    ["create_presentation", { title: "Deck", sourcePath: "/external" }],
    [
      "update_presentation",
      {
        documentId: "deck",
        expectedRevision: -1,
        requestId: "r",
        operation: { type: "delete", slideId: "slide" },
      },
    ],
    [
      "update_presentation",
      {
        documentId: "deck",
        expectedRevision: 0,
        requestId: "r",
        operation: { type: "move", slideId: "slide", toIndex: -1 },
      },
    ],
    ["control_presentation", { documentId: "deck", action: "eval" }],
    ["export_presentation", { documentId: "deck", format: "html" }],
    [
      "save_presentation",
      { documentId: "deck", path: "/external/deck.guzi-presentation" },
    ],
  ])
    assert.equal(
      (await client.callTool({ name, arguments: args })).isError,
      true,
    );
  assert.deepEqual(calls, []);
});

test("tool discovery exposes presentation safety annotations, explicit operations and hand-drawn defaults", async (t) => {
  const { client } = await fixture(t, async () => ({ result: {} }));
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const name of [
    "get_capabilities",
    "read_presentation",
    "export_presentation",
  ]) {
    assert.equal(byName[name].annotations.readOnlyHint, true);
    assert.equal(byName[name].annotations.destructiveHint, false);
  }
  assert.equal(byName.update_presentation.annotations.destructiveHint, true);
  assert.equal(byName.control_presentation.annotations.readOnlyHint, false);
  for (const tool of tools) assert.equal(tool.annotations.openWorldHint, false);
  assert.match(
    byName.create_presentation.description,
    /hand-drawn style by default/,
  );
  assert.match(byName.update_presentation.description, /copy_from/);
  assert.match(
    byName.update_presentation.description,
    /Source IDs grant no external path access/,
  );
  assert.match(byName.apply_operations.description, /type:'table'/);
  assert.match(byName.apply_operations.description, /type:'canvas'/);
  assert.match(byName.open_canvas.description, /\.guzi-presentation/);
  assert.equal(
    byName.read_canvas.inputSchema.properties.slideId.type,
    "string",
  );
});

test("advanced operations retain their explicit fields and reject unsupported operation shapes", () => {
  const args = {
    documentId: "deck",
    slideId: "slide",
    subsceneId: "nested",
    expectedRevision: 0,
    requestId: "advanced",
    operations: [
      {
        type: "create",
        tempId: "table",
        element: {
          type: "table",
          x: 0,
          y: 0,
          rows: [100],
          columns: [100],
          cells: [
            {
              row: 0,
              column: 0,
              richText: {
                version: 1,
                paragraphs: [{ runs: [{ text: "A", bold: true }] }],
              },
            },
          ],
        },
      },
      {
        type: "create",
        element: {
          type: "image",
          x: 0,
          y: 0,
          file: {
            mimeType: "image/png",
            dataURL: "data:image/png;base64,aW1hZ2U=",
          },
        },
      },
      {
        type: "create",
        element: {
          type: "freedraw",
          x: 0,
          y: 0,
          points: [
            [0, 0],
            [10, 10],
          ],
          pressures: [0.2, 0.5],
        },
      },
      {
        type: "table",
        id: "table",
        merge: { row: 0, column: 0, endRow: 0, endColumn: 1 },
      },
      { type: "group", ids: ["a", "b"] },
      { type: "ungroup", ids: ["a", "b"] },
      { type: "lock", ids: ["a"], locked: false },
      { type: "order", ids: ["a"], position: "front" },
      { type: "frame", ids: ["a"], frameId: null },
      { type: "subcanvas", id: "a", title: "Nested" },
      { type: "canvas", patch: { gridSize: 20, gridModeEnabled: true } },
    ],
  };
  assert.deepEqual(toolSchemas.apply_operations.parse(args), args);
  for (const operation of [
    { type: "group", ids: [], script: "eval" },
    { type: "lock", ids: ["a"], locked: "yes" },
    { type: "canvas", patch: { gridSize: 0 } },
    { type: "canvas", patch: { arbitrary: true } },
    { type: "table", id: "a", cells: [{ row: 100, column: 0 }] },
  ])
    assert.equal(
      toolSchemas.apply_operations.safeParse({
        ...args,
        operations: [operation],
      }).success,
      false,
    );
});

test("PDF exports become embedded binary resources without duplicated file bytes in metadata", () => {
  const result = toToolResult({
    result: {
      documentId: "deck",
      revision: 7,
      file: {
        data: "JVBERi0=",
        mimeType: "application/pdf",
        name: "Deck #1.pdf",
      },
    },
  });
  assert.deepEqual(result.content[0], {
    type: "resource",
    resource: {
      uri: "guzi://presentation/deck/Deck%20%231.pdf",
      mimeType: "application/pdf",
      blob: "JVBERi0=",
    },
  });
  assert.deepEqual(result.structuredContent, {
    documentId: "deck",
    revision: 7,
  });
  assert.equal(result.content[1].text.includes("JVBERi0="), false);
});

test("canvas control and document close dispatch exact local actions including empty selection", async (t) => {
  const calls = [];
  const { client } = await fixture(t, async (command, args) => {
    calls.push({ command, args });
    return { result: { documentId: "canvas", revision: 4 } };
  });
  const requests = [
    ["close_document", { documentId: "canvas" }],
    ["control_canvas", { documentId: "canvas", action: "undo" }],
    ["control_canvas", { documentId: "canvas", action: "redo" }],
    [
      "control_canvas",
      { documentId: "deck", slideId: "slide", action: "select", ids: [] },
    ],
    [
      "control_canvas",
      { documentId: "canvas", action: "select", ids: ["shape"] },
    ],
    ["control_canvas", { documentId: "canvas", action: "fit" }],
    ["control_canvas", { documentId: "canvas", action: "fit", ids: ["shape"] }],
    ["control_canvas", { documentId: "canvas", action: "zoom", zoom: 0.1 }],
    ["control_canvas", { documentId: "canvas", action: "zoom", zoom: 10 }],
  ];
  for (const [name, args] of requests) {
    assert.notEqual(
      (await client.callTool({ name, arguments: args })).isError,
      true,
    );
  }
  assert.deepEqual(
    calls,
    requests.map(([command, args]) => ({ command, args })),
  );
  const { tools } = await client.listTools();
  const control = tools.find(({ name }) => name === "control_canvas");
  const close = tools.find(({ name }) => name === "close_document");
  assert.equal(control.annotations.readOnlyHint, false);
  assert.equal(control.annotations.destructiveHint, true);
  assert.match(control.description, /read_canvas before invoking/);
  assert.equal(close.annotations.readOnlyHint, false);
  assert.match(close.description, /UNSAVED_CHANGES/);
  assert.match(close.description, /no discard option/);
});

test("close refuses discard switches and control rejects subscene targets and out-of-range zoom", async (t) => {
  const calls = [];
  const { client } = await fixture(t, async (command) => {
    calls.push(command);
    return {
      error: { code: "UNSAVED_CHANGES", message: "Save before closing." },
    };
  });
  for (const [name, args] of [
    ["close_document", { documentId: "canvas", discard: true }],
    ["close_document", { documentId: "canvas", force: true }],
    [
      "control_canvas",
      { documentId: "canvas", subsceneId: "nested", action: "undo" },
    ],
    ["control_canvas", { documentId: "canvas", action: "zoom", zoom: 0.09 }],
    ["control_canvas", { documentId: "canvas", action: "zoom", zoom: 10.01 }],
    ["control_canvas", { documentId: "canvas", action: "eval" }],
    ["control_canvas", { documentId: "canvas", action: "select", ids: [""] }],
  ])
    assert.equal(
      (await client.callTool({ name, arguments: args })).isError,
      true,
    );
  assert.deepEqual(calls, []);
  const dirty = await client.callTool({
    name: "close_document",
    arguments: { documentId: "canvas" },
  });
  assert.equal(dirty.isError, true);
  assert.equal(dirty.structuredContent.error.code, "UNSAVED_CHANGES");
  assert.deepEqual(calls, ["close_document"]);
});
