import { createThumbnailCache } from "./thumbnailCache";

it("bounds concurrent work, deduplicates consumers and cancels queued requests", async () => {
  const cache = createThumbnailCache(1024, 2);
  const complete: ((value: string) => void)[] = [];
  const render = vi.fn(
    () => new Promise<string>((resolve) => complete.push(resolve)),
  );
  const first = cache.acquire("first", render);
  const same = cache.acquire("first", render);
  const second = cache.acquire("second", render);
  const third = cache.acquire("third", render);
  expect(render).toHaveBeenCalledTimes(2);
  same.release();
  third.release();
  await expect(third.promise).resolves.toBe(null);
  complete[0]("first-value");
  complete[1]("second-value");
  await expect(first.promise).resolves.toBe("first-value");
  await expect(second.promise).resolves.toBe("second-value");
  expect(render).toHaveBeenCalledTimes(2);
});

it("evicts old values by bytes and removes failed work for retries", async () => {
  const cache = createThumbnailCache(20, 1);
  const render = vi.fn(async () => "12345678");
  await cache.acquire("first", render).promise;
  await cache.acquire("second", render).promise;
  await cache.acquire("first", render).promise;
  expect(render).toHaveBeenCalledTimes(3);
  const failure = cache.acquire("failure", async () => {
    throw new Error("broken");
  });
  await expect(failure.promise).rejects.toThrow("broken");
  await expect(
    cache.acquire("failure", async () => "recovered").promise,
  ).resolves.toBe("recovered");
});

it("marks released in-flight work cancelled and frees the concurrency slot on completion", async () => {
  const cache = createThumbnailCache(1024, 1);
  let finish!: (value: string) => void;
  let cancelled!: () => boolean;
  const first = cache.acquire("first", (check) => {
    cancelled = check;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const nextRender = vi.fn(async () => "next");
  const next = cache.acquire("next", nextRender);
  first.release();
  expect(cancelled()).toBe(true);
  finish("obsolete");
  await expect(first.promise).resolves.toBe(null);
  await expect(next.promise).resolves.toBe("next");
});
