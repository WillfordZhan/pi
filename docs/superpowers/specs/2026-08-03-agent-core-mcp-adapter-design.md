# Agent Core MCP Adapter Design

## Goal

Add a small MCP client adapter to `@earendil-works/pi-agent-core` so an
`AgentHarness` can use tools exposed by the ERP MCP server without depending on
`pi-coding-agent` or changing the agent's system prompt, resource loading, or
default tools.

## Scope

The first version supports the path required by the ERP integration:

- MCP Streamable HTTP transport.
- Optional static HTTP headers for authentication.
- Server initialization and tool discovery.
- Conversion of discovered MCP tools to `AgentHarnessTool` values.
- Forwarding tool arguments and returning MCP text, image, and structured
  results to the agent loop.
- Explicit connection shutdown.

The first version does not support stdio servers, OAuth discovery, MCP
resources, MCP prompts, config-file discovery, proxy/search tools, status UI,
or automatic reconnection. These can be added only when a concrete consumer
requires them.

## Public API

Expose one connection helper from `@earendil-works/pi-agent-core`:

```ts
const connection = await connectMcpServer({
  name: "erp",
  url: new URL("http://localhost:8080/mcp"),
  headers: { Authorization: "Bearer ..." },
});

const harness = new AgentHarness({
  // Existing AgentHarness options are unchanged.
  tools: connection.tools,
});

await connection.close();
```

The connection owns the official MCP SDK client and transport. Tool names and
descriptions remain those declared by the server. The adapter does not inject
prompts, filesystem tools, shell tools, or ERP-specific arguments.

Trusted tenant, user, trace, confirmation, and idempotency values remain an
application concern. The ERP agent can wrap an adapter tool or its MCP server
can derive these values from authenticated request context; they must not be
invented by the generic adapter.

## Data Flow

```text
AgentHarness
  -> adapter AgentHarnessTool.execute()
  -> MCP tools/call over Streamable HTTP
  -> ERP MCP server
  -> MCP result mapping
  -> AgentHarness tool result
```

Tool input schemas are passed through from MCP JSON Schema instead of being
rewritten. Text and image content are preserved. Structured content and other
diagnostic result data are retained in tool-result details so callers can
inspect them without exposing implementation-specific fields in the model's
prompt.

## Error Handling

- Connection and initialization failures reject `connectMcpServer`.
- MCP tool errors become failed tool executions with the server's diagnostic
  message preserved.
- The adapter does not automatically replay `tools/call`. ERP create/update
  operations may only be retried after the application provides idempotency.
- Closing an already closed connection is safe.

## Dependency

Use the official `@modelcontextprotocol/sdk` as an exact, reviewed runtime
dependency. Do not depend on the third-party `pi-mcp-adapter` because it targets
the coding-agent extension host and includes behavior outside this scope.

## Verification

- Unit-test tool discovery and JSON Schema pass-through.
- Unit-test text, image, structured result, and MCP error mapping.
- Unit-test close behavior.
- Run the new focused test, then run `npm run check` as required by the
  repository.

