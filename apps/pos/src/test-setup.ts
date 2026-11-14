// Fresh in-memory IndexedDB for every test.
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach } from "vitest";
import { resetConnection } from "./db";

beforeEach(() => {
  resetConnection();
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
});
