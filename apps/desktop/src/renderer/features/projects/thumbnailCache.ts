type Entry = {
  promise: Promise<string | null>;
  resolve: (value: string | null) => void;
  reject: (reason: unknown) => void;
  run: (cancelled: () => boolean) => Promise<string | null>;
  users: number;
  bytes: number;
  started: boolean;
  settled: boolean;
  cancelled: boolean;
};

export const createThumbnailCache = (
  byteBudget = 24 * 1024 * 1024,
  concurrency = 2,
) => {
  const entries = new Map<string, Entry>();
  const queue: { key: string; entry: Entry }[] = [];
  let bytes = 0;
  let running = 0;
  const remove = (key: string, entry: Entry) => {
    if (entries.get(key) === entry) {
      entries.delete(key);
      bytes -= entry.bytes;
    }
  };
  const trim = () => {
    for (const [key, entry] of entries) {
      if (bytes <= byteBudget && entries.size <= 120) {
        break;
      }
      if (entry.settled) {
        remove(key, entry);
      }
    }
  };
  const start = (key: string, entry: Entry) => {
    running++;
    entry.started = true;
    void entry
      .run(() => entry.cancelled)
      .then(
        (value) => {
          entry.settled = true;
          if (!entry.cancelled && entries.get(key) === entry) {
            entry.bytes = (value?.length ?? 0) * 2;
            bytes += entry.bytes;
            trim();
          }
          entry.resolve(entry.cancelled ? null : value);
        },
        (error) => {
          remove(key, entry);
          entry.settled = true;
          if (entry.cancelled) {
            entry.resolve(null);
          } else {
            entry.reject(error);
          }
        },
      )
      .finally(() => {
        running--;
        drain();
      });
  };
  const drain = () => {
    while (running < concurrency && queue.length) {
      const { key, entry } = queue.shift()!;
      if (!entry.cancelled) {
        start(key, entry);
      }
    }
  };
  return {
    acquire(key: string, run: Entry["run"]) {
      let entry = entries.get(key);
      if (!entry) {
        let resolve!: Entry["resolve"];
        let reject!: Entry["reject"];
        const promise = new Promise<string | null>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        entry = {
          promise,
          resolve,
          reject,
          run,
          users: 0,
          bytes: 0,
          started: false,
          settled: false,
          cancelled: false,
        };
        entries.set(key, entry);
        queue.push({ key, entry });
      } else {
        entries.delete(key);
        entries.set(key, entry);
      }
      const acquired = entry;
      acquired.users++;
      drain();
      let released = false;
      return {
        promise: acquired.promise,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          acquired.users--;
          if (!acquired.users && !acquired.settled) {
            acquired.cancelled = true;
            remove(key, acquired);
            if (!acquired.started) {
              const index = queue.findIndex((job) => job.entry === acquired);
              if (index >= 0) {
                queue.splice(index, 1);
              }
              acquired.resolve(null);
            }
          }
        },
      };
    },
  };
};
