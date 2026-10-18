import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
export class Database {
  readonly pool: pg.Pool;
  readonly orm;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 12 });
    this.orm = drizzle(this.pool, { schema });
  }
  async query<T extends pg.QueryResultRow = any>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.pool.query<T>(sql, values)).rows;
  }
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new Transaction(client));
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  close() {
    return this.pool.end();
  }
  async withLock<T>(
    key: string,
    fn: (db: Queryable) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        key,
      ]);
      return await fn({
        query: async (sql: string, values: unknown[] = []) =>
          (await client.query(sql, values)).rows,
      });
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        key,
      ]);
      client.release();
    }
  }
}
export class Transaction {
  constructor(readonly client: pg.PoolClient) {}
  async query<T extends pg.QueryResultRow = any>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.client.query<T>(sql, values)).rows;
  }
  async userLock(id: string) {
    await this.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `user:${id}`,
    ]);
    await this.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [id]);
  }
}
export type Queryable = Pick<Database, "query">;
