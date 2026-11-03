import { importPdf, PDF_IMPORT_LIMITS } from "./importPdf";
import { isPaperFrame, PAPER_GAP } from "./paper";

const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: "" },
}));
vi.mock("pdfjs-dist", () => pdfjs);
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({
  default: "/pdf.worker.mjs",
}));

describe("PDF import", () => {
  const createTask = (count = 2) => {
    const render = vi.fn(() => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }));
    const cleanup = vi.fn();
    const getPage = vi.fn(async (index: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: (index === 1 ? 612 : 792) * scale,
        height: (index === 1 ? 792 : 612) * scale,
      }),
      render,
      cleanup,
    }));
    const task = {
      promise: Promise.resolve({ numPages: count, getPage }),
      destroy: vi.fn(async () => {}),
    };
    pdfjs.getDocument.mockReturnValue(task);
    return { task, render, cleanup, getPage };
  };

  beforeEach(() => vi.clearAllMocks());

  it("imports all pages sequentially with embedded images, dimensions and cleanup", async () => {
    const { task, render, cleanup } = createTask();
    const progress = vi.fn();
    const scene = await importPdf(
      new ArrayBuffer(10),
      document,
      new AbortController().signal,
      progress,
    );
    const frames = scene.elements!.filter(isPaperFrame);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      width: 816,
      height: 1056,
      y: 0,
      locked: true,
    });
    expect(frames[1]).toMatchObject({
      width: 1056,
      height: 816,
      y: 1056 + PAPER_GAP,
    });
    const images = scene.elements!.filter(
      (element) => element.type === "image",
    );
    expect(
      images.every(
        (image) =>
          image.fileId &&
          scene.files![image.fileId]?.dataURL.startsWith("data:image/png"),
      ),
    ).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
    expect(render).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not return a partial document when cancellation occurs between pages", async () => {
    const { task, getPage } = createTask();
    const controller = new AbortController();
    await expect(
      importPdf(new ArrayBuffer(10), document, controller.signal, (page) => {
        if (page === 1) {
          controller.abort();
        }
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized documents before rendering and destroys the worker", async () => {
    const { task, render } = createTask(PDF_IMPORT_LIMITS.pages + 1);
    await expect(
      importPdf(
        new ArrayBuffer(10),
        document,
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow("200");
    expect(render).not.toHaveBeenCalled();
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("reports encrypted documents and still releases parser resources", async () => {
    const destroy = vi.fn(async () => {});
    pdfjs.getDocument.mockReturnValue({
      promise: Promise.reject(
        Object.assign(new Error("Password"), { name: "PasswordException" }),
      ),
      destroy,
    });
    await expect(
      importPdf(
        new ArrayBuffer(10),
        document,
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow("已加密");
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
