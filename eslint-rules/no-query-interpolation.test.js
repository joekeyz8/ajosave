/**
 * Tests for the no-query-interpolation ESLint rule.
 * Run with: node eslint-rules/no-query-interpolation.test.js
 */

"use strict";

const { RuleTester } = require("eslint");
const rule = require("./no-query-interpolation");

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2020 },
});

tester.run("no-query-interpolation", rule, {
  valid: [
    // Plain string with $N placeholders — always safe
    { code: `query('SELECT * FROM users WHERE id = $1', [id])` },
    { code: `query("SELECT * FROM circles WHERE status = $1", [status])` },
    // Template literal with no expressions — safe (static SQL)
    { code: "query(`SELECT * FROM users WHERE deleted_at IS NULL`)" },
    // Static template literal with $N placeholders — safe
    { code: "query(`SELECT * FROM users WHERE id = $1`, [id])" },
    // Member call: db.query with no interpolation
    { code: `db.query('SELECT 1')` },
    // A different function name — not guarded
    { code: "fetch(`https://api.example.com/${path}`)" },
    // Non-string first arg (unusual but not flagged)
    { code: "query(sqlVar, [id])" },
  ],

  invalid: [
    // Template literal with interpolation
    {
      code: "query(`SELECT * FROM users WHERE id = '${id}'`)",
      errors: [{ messageId: "templateLiteral" }],
    },
    // Template literal interpolation in table name position
    {
      code: "query(`SELECT * FROM ${table} WHERE id = $1`, [id])",
      errors: [{ messageId: "templateLiteral" }],
    },
    // Multiple interpolations
    {
      code: "query(`SELECT * FROM ${table} WHERE ${col} = '${val}'`)",
      errors: [{ messageId: "templateLiteral" }],
    },
    // String concatenation with literal
    {
      code: "query('SELECT * FROM users WHERE id = ' + id)",
      errors: [{ messageId: "stringConcatenation" }],
    },
    // String concatenation with leading literal
    {
      code: "query('SELECT * FROM ' + tableName + ' WHERE id = $1', [id])",
      errors: [{ messageId: "stringConcatenation" }],
    },
    // Member call: db.query with interpolation
    {
      code: "db.query(`SELECT * FROM users WHERE phone = '${phone}'`)",
      errors: [{ messageId: "templateLiteral" }],
    },
    // boundQuery (transaction helper)
    {
      code: "boundQuery(`DELETE FROM ${table} WHERE id = $1`, [id])",
      errors: [{ messageId: "templateLiteral" }],
    },
    // Extra function name via options
    {
      code: "execute(`SELECT * FROM users WHERE id = '${id}'`)",
      options: [{ functions: ["execute"] }],
      errors: [{ messageId: "templateLiteral" }],
    },
  ],
});

console.log("✓ no-query-interpolation: all tests passed");
