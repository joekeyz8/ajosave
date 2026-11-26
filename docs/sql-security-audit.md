# SQL Injection Prevention — Security Audit

## Status: ✅ Compliant — automated enforcement active

All database access goes through `src/lib/db.ts` which enforces parameterised
queries via the `pg` driver's `$1, $2, …` placeholder syntax.  String
interpolation into `query()` calls is now prohibited by a mandatory ESLint rule
that runs on every CI push.

---

## Automated enforcement

### ESLint rule: `local/no-query-interpolation`

**Rule file:** `eslint-rules/no-query-interpolation.js`  
**Rule tests:** `eslint-rules/no-query-interpolation.test.js`

The rule flags any `query()` or `boundQuery()` call whose first argument:

- is a template literal containing a `${…}` expression, or
- uses string concatenation (`+`) with a non-constant operand.

It fires as an **error** (not a warning) so it blocks CI merges.

**To run locally:**
```sh
npm run lint:sql
```

**CI step:** `lint-and-type-check` job in `.github/workflows/ci.yml` runs
`npm run lint:sql` as a mandatory gate on every push and pull request.

### Legitimate exceptions

Three files use dynamic query building where identifiers come exclusively from
static code constants, never from request input.  Each carries a justified
`eslint-disable` comment:

| File | Pattern | Why safe |
|---|---|---|
| `src/lib/retention.ts` | `${p.table}`, `${predicate}` | `p.table`/`p.column` come from the static `POLICIES` constant; `validatePolicy()` enforces `/^[a-z_]+$/` before any query runs |
| `src/lib/pagination.ts` | `${tableName}`, `${cursorField}`, `${filter.column}` | All callers pass hardcoded string literals; column names are double-quoted in the SQL |
| `src/server/services/contribution.service.ts` | `${whereClause}`, `${limitPlaceholder}` | Built from a code-controlled `conditions` array using only `$N` placeholders; all values are bound via the `params` array |

---

## Audit findings (initial scan)

The rule was run against all 40 source files that call `query()`.  Findings:

### True violations fixed

| File | Issue | Fix |
|---|---|---|
| `server/services/dispute.service.ts` | `${DISPUTE_SELECT}` interpolated into 5 query strings | Inlined column list as plain string literals in each query |
| `server/services/early-exit.service.ts` | `${EXIT_SELECT}` interpolated into 5 query strings | Inlined column list as plain string literals in each query |
| `server/services/feature-flag.service.ts` | `${FLAG_SELECT}` interpolated into 3 query strings | Inlined column list as plain string literals in each query |
| `server/services/admin.service.ts` | `${where}` clause built from optional search term | Rewrote as two separate static query strings (with/without search) |

None of these were exploitable — the interpolated values were always static
constants, never user input — but they violated the rule and created a
maintenance hazard where future edits could inadvertently introduce real
interpolation.

### Legitimate dynamic builders (not changed)

| File | Assessment |
|---|---|
| `src/lib/retention.ts` | Safe — identifiers from static `POLICIES` constant only, validated with regex |
| `src/lib/pagination.ts` | Safe — `tableName`/`cursorField` always hardcoded at call sites; values parameterised |
| `src/server/services/contribution.service.ts` | Safe — `whereClause` built from `$N`-only conditions array; values in `params` |

---

## Rules enforced

1. **Never interpolate user input into SQL strings.**
   ```ts
   // ❌ WRONG
   query(`SELECT * FROM users WHERE phone = '${phone}'`)

   // ✅ CORRECT
   query('SELECT * FROM users WHERE phone = $1', [phone])
   ```

2. **All input validated with Zod schemas before reaching the DB layer.**

3. **All DB access goes through `src/lib/db.ts` — no direct `pg` client usage.**

4. **Transactions used for multi-step writes** to prevent partial state.

5. **Dynamic identifiers (table/column names) must come only from allowlisted
   static constants** and must be validated against `/^[a-z_]+$/` before use.

---

## Sign-off

Audit completed and rule enforced.  All `query()` call sites reviewed.
No user-controlled input reaches any SQL string as an interpolated value.
