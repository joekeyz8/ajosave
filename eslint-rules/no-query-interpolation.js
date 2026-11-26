/**
 * ESLint rule: no-query-interpolation
 *
 * Flags any call to `query(...)` or `transaction(...)` where the first
 * argument is a template literal that contains an interpolated expression
 * (`${ ... }`).  String concatenation as the first argument is also flagged.
 *
 * Safe patterns:
 *   query('SELECT * FROM users WHERE id = $1', [id])
 *   query(`SELECT * FROM users WHERE id = $1`, [id])
 *
 * Flagged patterns:
 *   query(`SELECT * FROM users WHERE id = '${id}'`)
 *   query('SELECT * FROM ' + tableName)
 *
 * Intentional exceptions documented in the codebase:
 *   - retention.ts: table/column names come from a closed static POLICIES
 *     constant validated by validatePolicy() — never from request input.
 *   - pagination.ts: buildCursorQuery() wraps column/table names in
 *     double-quotes and all values are bound via $N placeholders.
 *   These files carry an eslint-disable comment with justification.
 */

"use strict";

/** Function names whose first argument must not be an interpolated string. */
const GUARDED_FUNCTIONS = new Set(["query", "boundQuery"]);

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow string interpolation or concatenation inside query() calls to prevent SQL injection.",
      category: "Security",
      recommended: true,
      url: "https://github.com/BarryArinze/ajosave/blob/main/docs/sql-security-audit.md",
    },
    messages: {
      templateLiteral:
        "SQL injection risk: query() first argument must not contain template literal expressions (${}). Use parameterized placeholders ($1, $2, …) and pass values as the second argument.",
      stringConcatenation:
        "SQL injection risk: query() first argument must not use string concatenation (+). Use parameterized placeholders ($1, $2, …) and pass values as the second argument.",
    },
    schema: [
      {
        type: "object",
        properties: {
          /** Additional function names to guard beyond the defaults. */
          functions: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },

  create(context) {
    const extraFunctions = context.options[0]?.functions ?? [];
    const guarded = new Set([...GUARDED_FUNCTIONS, ...extraFunctions]);

    function isGuardedCall(node) {
      if (node.type !== "CallExpression") return false;
      const callee = node.callee;
      // Direct call: query(...)
      if (callee.type === "Identifier" && guarded.has(callee.name)) return true;
      // Member call: db.query(...) or client.query(...)
      if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
        return guarded.has(callee.property.name);
      }
      return false;
    }

    function checkFirstArg(node, firstArg) {
      if (!firstArg) return;

      // Template literal with at least one expression: `...${expr}...`
      if (
        firstArg.type === "TemplateLiteral" &&
        firstArg.expressions.length > 0
      ) {
        context.report({ node: firstArg, messageId: "templateLiteral" });
        return;
      }

      // String concatenation: 'SELECT' + var or var + 'FROM'
      if (isConcatenation(firstArg)) {
        context.report({ node: firstArg, messageId: "stringConcatenation" });
      }
    }

    function isConcatenation(node) {
      if (node.type !== "BinaryExpression" || node.operator !== "+") return false;
      // At least one operand must be a string literal or template literal
      // (to avoid flagging unrelated + expressions)
      return (
        isStringish(node.left) ||
        isStringish(node.right) ||
        isConcatenation(node.left) ||
        isConcatenation(node.right)
      );
    }

    function isStringish(node) {
      return (
        node.type === "Literal" && typeof node.value === "string" ||
        node.type === "TemplateLiteral"
      );
    }

    return {
      CallExpression(node) {
        if (!isGuardedCall(node)) return;
        checkFirstArg(node, node.arguments[0]);
      },
    };
  },
};
