import {
  type ActionRequest,
  type AppApi,
  type AppManifest,
  DataLayer,
  type EngineClient,
  type EngineJob,
  type GatewayDataSource,
  type HttpRequest,
  type ProvisionedSource,
  type SqliteDb,
  type Table,
  type TableMeta,
  type WorkerSubscription,
} from "@nanobpm/urban";

export interface LooseTestValue {
  [key: string]: unknown;
  [index: number]: LooseTestValue;
  status: unknown;
  result: string;
  body: LooseTestValue;
  prs: LooseTestValue[];
  entries: LooseTestValue[];
  conflicts: LooseTestValue[];
  patch: LooseTestValue;
  _plans: LooseTestValue[];
  length: number;
  at(index: number): LooseTestValue | undefined;
}

export type TestRow = Record<string, unknown>;
export interface TableUpdate<T extends TestRow> {
  key: unknown;
  patch: Partial<T>;
}

export type MemTable<T extends TestRow> = Table<T> & {
  rows: T[];
  inserts: Partial<T>[];
  updates: TableUpdate<T>[];
};

const matches = <T extends TestRow>(row: T, where: Partial<T>): boolean =>
  Object.entries(where).every(([key, value]) => row[key] === value);

export function memTable<T extends TestRow>(rows: T[], key: keyof T & string): MemTable<T> {
  const inserts: Partial<T>[] = [];
  const updates: TableUpdate<T>[] = [];
  const table = {
    rows,
    inserts,
    updates,
    async get(id: unknown): Promise<T | undefined> {
      return rows.find((row) => row[key] === id);
    },
    async all(limit?: number): Promise<T[]> {
      return typeof limit === "number" ? rows.slice(0, limit) : [...rows];
    },
    async find(where: Partial<T> = {}): Promise<T[]> {
      return rows.filter((row) => matches(row, where));
    },
    async findOne(where: Partial<T> = {}): Promise<T | undefined> {
      return rows.find((row) => matches(row, where));
    },
    async count(where: Partial<T> = {}): Promise<number> {
      return rows.filter((row) => matches(row, where)).length;
    },
    async insert(row: Partial<T>): Promise<number | bigint> {
      inserts.push(row);
      // biome-ignore lint/plugin: typed test-double boundary (partial inserts become row values)
      rows.push({ ...row } as T);
      const inserted = rows.at(-1);
      const id = inserted?.[key];
      return typeof id === "number" || typeof id === "bigint" ? id : rows.length;
    },
    async update(id: unknown, patch: Partial<T>): Promise<number> {
      updates.push({ key: id, patch });
      const row = rows.find((candidate) => candidate[key] === id);
      if (!row) return 0;
      Object.assign(row, patch);
      return 1;
    },
    async delete(id: unknown): Promise<number> {
      let deleted = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]?.[key] === id) {
          rows.splice(i, 1);
          deleted++;
        }
      }
      return deleted;
    },
  };
  // biome-ignore lint/plugin: typed test-double boundary (Table<T> has private runtime internals)
  return table as MemTable<T>;
}

type TableMap = Record<string, ReturnType<typeof memTable>>;

const notImplemented = (name: string): never => {
  throw new Error(`${name} not implemented in test double`);
};

function fakeSqliteDb(): SqliteDb {
  const db = {
    exec: (sql: string) => notImplemented(`sqlite.exec(${sql})`),
    run: (sql: string) => notImplemented(`sqlite.run(${sql})`),
    all: <T = Record<string, unknown>>(sql: string): T[] => notImplemented(`sqlite.all(${sql})`),
    close: () => {},
  };
  return db;
}

export function fakeDataLayer(tables: TableMap = {}): DataLayer {
  const source: GatewayDataSource = {
    query: () => notImplemented("data.query"),
    exec: () => notImplemented("data.exec"),
    tx: () => notImplemented("data.tx"),
    schema: async (): Promise<TableMeta[]> => [],
    table<T extends object = TestRow>(name: string, pk = "id"): Table<T> {
      let table = tables[name];
      if (!table) {
        table = memTable<TestRow>([], pk);
        tables[name] = table;
      }
      // biome-ignore lint/plugin: typed test-double boundary (DataLayer.table<T> supplies caller row type)
      return table as Table<T>;
    },
  };
  const provisioned: ProvisionedSource = {
    name: "default",
    driver: "memory",
    db: fakeSqliteDb(),
    source,
    migrationsApplied: [],
    close: () => {},
  };
  return new DataLayer(new Map([["default", provisioned]]), "default", {});
}

export function fakeEngineClient(overrides: Partial<EngineClient> = {}): EngineClient {
  return {
    deployResources: () => notImplemented("engine.deployResources"),
    createInstance: () => notImplemented("engine.createInstance"),
    cancelInstance: () => notImplemented("engine.cancelInstance"),
    publishMessage: () => notImplemented("engine.publishMessage"),
    searchUserTasks: () => notImplemented("engine.searchUserTasks"),
    completeUserTask: () => notImplemented("engine.completeUserTask"),
    searchProcessInstances: () => notImplemented("engine.searchProcessInstances"),
    registerWorker: () => notImplemented("engine.registerWorker"),
    close: () => notImplemented("engine.close"),
    ...overrides,
  };
}

export function fakeAppApi(overrides: Partial<AppApi> = {}): AppApi {
  return {
    // biome-ignore lint/plugin: typed test-double boundary (minimal manifest is sufficient here)
    manifest: {} as AppManifest,
    data: fakeDataLayer(),
    engine: fakeEngineClient(),
    env: () => undefined,
    log: () => {},
    ...overrides,
  };
}

export function fakeJob<In extends TestRow>(variables: In, overrides: Partial<EngineJob<In>> = {}): EngineJob<In> {
  return {
    jobKey: "test-job",
    jobType: "test",
    variables,
    ...overrides,
  };
}

export function fakeHttpRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: "GET",
    path: "/",
    query: new URLSearchParams(),
    headers: new Headers(),
    text: async () => "",
    ...overrides,
  };
}

export function fakeActionRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    req: fakeHttpRequest(),
    body: {},
    ...overrides,
  };
}

export function fakeWorkerSubscription(jobType = "test"): WorkerSubscription {
  return {
    jobType,
    unsubscribe: async () => {},
  };
}

export function testBoundary<T = LooseTestValue>(value: unknown): T {
  // biome-ignore lint/plugin: typed test boundary for legacy framework/interface seams
  return value as T;
}
