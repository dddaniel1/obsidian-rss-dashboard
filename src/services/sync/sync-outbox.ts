export type SyncOperation = {
  id: string;
  accountId: string;
} & (
  | { kind: "article-state"; articleId: string; field: "read" | "starred"; value: boolean }
  | { kind: "subscribe"; localId: string; url: string; title: string; folder: string }
  | { kind: "unsubscribe"; feedId: string }
  | { kind: "edit-feed"; feedId: string; title: string; folder: string }
  | { kind: "rename-folder"; folder: string; name: string }
  | { kind: "delete-folder"; folder: string }
);

/** Durable intent is independent of article caches and remote snapshots. */
export class SyncOutbox {
  private operations: SyncOperation[];
  private writes: Promise<void> = Promise.resolve();

  constructor(
    initial: SyncOperation[],
    private readonly persist: (operations: SyncOperation[]) => Promise<void>,
  ) {
    this.operations = structuredClone(initial);
  }

  list(): SyncOperation[] {
    return structuredClone(this.operations);
  }

  enqueue(operation: SyncOperation): Promise<void> {
    const input = structuredClone(operation);
    return this.update((items) => {
      if (items.some((item) => item.id === input.id)) {
        throw new Error("Duplicate sync operation ID");
      }
      return [...items, input];
    });
  }

  acknowledge(id: string): Promise<void> {
    return this.update((items) => items.filter((item) => item.id !== id));
  }

  private update(
    transform: (items: SyncOperation[]) => SyncOperation[],
  ): Promise<void> {
    const task = this.writes.then(async () => {
      const next = transform(this.list());
      await this.persist(structuredClone(next));
      this.operations = next;
    });
    // A failed disk write must not poison subsequent attempts.
    this.writes = task.catch(() => {});
    return task;
  }
}
