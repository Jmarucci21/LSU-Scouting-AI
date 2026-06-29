---
name: Drizzle bulk update with JS arrays
description: Why unnest(${array}) fails in drizzle sql`` and the VALUES-list pattern to use instead for bulk UPDATE ... FROM.
---

# Drizzle bulk update from a JS array

When you interpolate a JS array into a drizzle `sql\`\`` template, drizzle expands
it into a comma list of individual placeholders (`$1, $2, $3, ...`), the same way
`inArray` does. It does NOT bind it as a single Postgres array parameter.

So `unnest(${pids}::text[])` compiles to `unnest(($1, $2, ...)::text[])` — a row
expression cast, not an array — and Postgres rejects it at runtime ("Failed
query ... unnest(($1, $2, ...)").

**Use a VALUES list built with `sql.join` instead** for bulk `UPDATE ... FROM`:

```ts
for (let i = 0; i < entries.length; i += 500) {
  const rows = entries.slice(i, i + 500);
  const values = sql.join(rows.map(([a, b]) => sql`(${a}, ${b})`), sql`, `);
  await tx.execute(sql`
    UPDATE ${someTable} AS p
    SET col = v.b
    FROM (VALUES ${values}) AS v(a, b)
    WHERE p.key = v.a::text
  `);
}
```

**Why:** drizzle's array interpolation is list-expansion, not array-binding.
**How to apply:** any time you want to bulk-update/insert many key→value pairs in
one statement, chunk (~500 rows = ~1000 params, well under the 65535 limit) and
use a parameterized VALUES list; cast the join column (`v.a::text`) since VALUES
params come in untyped.
