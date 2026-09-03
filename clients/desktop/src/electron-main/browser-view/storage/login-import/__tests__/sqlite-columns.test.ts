import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  assertRowBudget,
  MAX_SQLITE_COOKIE_ROWS,
  SqliteRowBudgetError,
} from "../sqlite-columns";

/**
 * Builds an in-memory table with exactly `rowCount` rows, inserted through a
 * single recursive-CTE INSERT rather than one statement per row - a loop of
 * MAX_SQLITE_COOKIE_ROWS individual inserts would dominate the suite's
 * runtime for no reason `assertRowBudget` cares about (it only ever counts).
 */
function makeTableWithRows(rowCount: number): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE cookies (id INTEGER PRIMARY KEY)");
  database.exec(`
    INSERT INTO cookies (id)
    WITH RECURSIVE seq(x) AS (
      SELECT 1
      UNION ALL
      SELECT x + 1 FROM seq WHERE x < ${rowCount}
    )
    SELECT x FROM seq;
  `);
  return database;
}

describe("assertRowBudget", () => {
  it("throws SqliteRowBudgetError for a table one row past MAX_SQLITE_COOKIE_ROWS", () => {
    const database = makeTableWithRows(MAX_SQLITE_COOKIE_ROWS + 1);
    try {
      expect(() => assertRowBudget(database, "cookies")).toThrow(
        SqliteRowBudgetError,
      );
    } finally {
      database.close();
    }
  });

  it("does not throw for a table at exactly MAX_SQLITE_COOKIE_ROWS", () => {
    const database = makeTableWithRows(MAX_SQLITE_COOKIE_ROWS);
    try {
      expect(() => assertRowBudget(database, "cookies")).not.toThrow();
    } finally {
      database.close();
    }
  });
});
