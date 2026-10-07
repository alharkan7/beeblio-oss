declare module "better-sqlite3" {
  namespace Database {
    interface Database {
      /** With `simple`, the first column of the first row; otherwise every row. */
      pragma(source: string, options?: { simple?: boolean }): unknown;
    }
  }
  const Database: new (path: string, options?: { timeout?: number }) => Database.Database;
  export default Database;
}
