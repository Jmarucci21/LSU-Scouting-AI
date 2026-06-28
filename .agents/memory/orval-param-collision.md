---
name: Orval path+query param name collision
description: TS2308 codegen collision when an OpenAPI operation has BOTH a path param and query params
---

# Orval `*Params` collision (TS2308)

When an OpenAPI operation has BOTH a path parameter AND query parameters, the
zod target emits a `<Op>Params` const (for the path param) while the schemas/types
target emits a `<Op>Params` TypeScript type. The api-zod barrel re-exports both
generated/api (zod) and generated/types, so the two `<Op>Params` names collide →
`TS2308: Module ... has already exported a member named 'GetPlayerParams'`.

**Why:** query-only operations are safe because the zod query schema is named
`<Op>QueryParams` (≠ the `<Op>Params` type). Only the path-param zod schema reuses
the bare `<Op>Params` name, which clashes.

**How to apply:** for single-resource GET endpoints, keep them path-param-only —
do not add query params to an operation that already has a path param. Push
optional filters (e.g. `season`) to server-side defaults or a separate
list/collection endpoint instead. Then `pnpm --filter @workspace/api-spec run codegen`.
