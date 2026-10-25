const path = require("node:path").posix;
const { spawn } = require("node:child_process");

const MAC_UPDATE_FEED =
  "https://github.com/Drangon-Li/guzi-graph/releases/latest/download/mac-arm64-appcast.xml";
const MAX_LINE_BYTES = 64 * 1024;

function createMacUpdateAdapter({
  resourcesPath,
  execPath,
  emit,
  spawnHelper = spawn,
  timeoutMs = 30 * 60 * 1000,
  installTimeoutMs = 15000,
  cancelTimeoutMs = 15000,
}) {
  let session;
  const executable = path.join(
    resourcesPath,
    "updater/Guzi Updater.app/Contents/MacOS/guzi-updater",
  );
  const host = path.resolve(execPath, "../../..");
  if (!host.endsWith(".app")) throw new Error("Invalid application bundle");
  const start = (mode) => {
    if (session) throw new Error("Update helper is busy");
    const child = spawnHelper(
      executable,
      ["--mode", mode, "--host", host, "--feed", MAC_UPDATE_FEED],
      { detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.unref();
    const current = {
      child,
      mode,
      buffer: "",
      ready: false,
      handedOff: false,
      cancelling: false,
    };
    current.promise = new Promise((resolve, reject) =>
      Object.assign(current, { resolve, reject }),
    );
    session = current;
    const cleanup = () => {
      clearTimeout(current.timer);
      clearTimeout(current.cancelTimer);
      child.stdout.removeListener("data", onData);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      // Stream error handlers stay attached while pipes close to absorb late EPIPE.
      child.stdin.end();
      child.stdout.destroy();
      child.stderr.destroy();
      if (session === current) session = undefined;
    };
    const send = (command) =>
      child.stdin.write(`${JSON.stringify({ command })}\n`);
    const cancel = () => {
      if (current.handedOff) return Promise.resolve();
      if (current.cancelPromise) return current.cancelPromise;
      current.cancelling = true;
      clearTimeout(current.timer);
      current.reject(new Error("Update cancelled"));
      current.rejectInstall?.(new Error("Update cancelled"));
      current.cancelPromise = new Promise((resolve, reject) =>
        Object.assign(current, {
          resolveCancel: resolve,
          rejectCancel: reject,
        }),
      );
      current.cancelPromise.catch(() => {});
      current.cancelTimer = setTimeout(
        () => current.rejectCancel(new Error("Update cancellation timed out")),
        cancelTimeoutMs,
      );
      current.cancelTimer.unref?.();
      send("cancel");
      child.stdin.end();
      return current.cancelPromise;
    };
    const fail = (error) => {
      if (current.handedOff || current.cancelling) return;
      current.reject(error);
      current.rejectInstall?.(error);
      emit({ status: "error" });
      void cancel();
    };
    const onError = (error) => {
      if (current.handedOff) return;
      current.reject(error);
      current.rejectInstall?.(error);
      current.rejectCancel?.(error);
      emit({ status: "error" });
      cleanup();
    };
    const onStderr = () => {};
    const onExit = (code) => {
      if (!current.handedOff) {
        if (code !== 0 || !current.completed) {
          const error = new Error("Update helper exited before completion");
          current.reject(error);
          current.rejectInstall?.(error);
          current.rejectCancel?.(error);
          emit({ status: "error" });
        }
      }
      cleanup();
    };
    const version = (value) => {
      if (typeof value !== "string" || !value.trim() || value.length > 128)
        throw new Error("Invalid update version");
      return value;
    };
    const onEvent = (value) => {
      if (!value || typeof value !== "object")
        throw new Error("Invalid helper event");
      if (current.cancelling) {
        if (
          value.event === "done" &&
          ["cancelled", "error", "available", "up-to-date"].includes(
            value.status,
          )
        ) {
          current.completed = true;
          current.resolveCancel();
          cleanup();
        }
        return;
      }
      switch (value.event) {
        case "checking":
          emit({ status: "checking" });
          break;
        case "available":
          current.finalStatus = "available";
          emit({
            status: "available",
            availableVersion: version(value.version),
          });
          break;
        case "up-to-date":
          current.finalStatus = "up-to-date";
          emit({ status: "up-to-date" });
          break;
        case "downloading":
          if (
            mode !== "download" ||
            !Number.isFinite(value.progress) ||
            value.progress < 0 ||
            value.progress > 1
          )
            throw new Error("Invalid download progress");
          emit({ status: "downloading", progress: value.progress * 100 });
          break;
        case "downloaded":
          if (mode !== "download")
            throw new Error("Unexpected downloaded event");
          current.ready = true;
          clearTimeout(current.timer);
          emit({
            status: "downloaded",
            availableVersion: version(value.version),
            progress: 100,
          });
          current.resolve();
          break;
        case "installing":
          if (!current.ready || !current.resolveInstall)
            throw new Error("Unexpected install acknowledgement");
          current.handedOff = true;
          current.resolveInstall();
          cleanup();
          break;
        case "done":
          if (
            !["available", "up-to-date"].includes(value.status) ||
            value.status !== current.finalStatus ||
            (mode === "download" && value.status !== "up-to-date")
          )
            throw new Error("Unexpected helper completion");
          current.completed = true;
          current.resolve();
          cleanup();
          break;
        case "error":
          throw new Error("Update helper reported failure");
        case "cancelled":
          throw new Error("Update helper cancelled");
        default:
          throw new Error("Unknown helper event");
      }
    };
    const onData = (data) => {
      current.buffer += data.toString("utf8");
      if (Buffer.byteLength(current.buffer) > MAX_LINE_BYTES) {
        current.buffer = "";
        fail(new Error("Update helper output exceeded limit"));
        return;
      }
      let newline;
      while ((newline = current.buffer.indexOf("\n")) !== -1) {
        const line = current.buffer.slice(0, newline);
        current.buffer = current.buffer.slice(newline + 1);
        try {
          if (line.trim()) onEvent(JSON.parse(line));
        } catch (error) {
          fail(error);
        }
        if (session !== current) return;
      }
    };
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.stdin.on("error", onError);
    child.stdout.on("error", onError);
    child.stderr.on("error", onError);
    child.on("error", onError);
    child.on("exit", onExit);
    current.cancel = cancel;
    current.timer = setTimeout(
      () => fail(new Error("Update helper timed out")),
      mode === "check" ? Math.min(timeoutMs, 60000) : timeoutMs,
    );
    current.timer.unref?.();
    return current.promise;
  };
  return {
    check: () => start("check"),
    download: () => start("download"),
    install() {
      const current = session;
      if (!current?.ready || current.cancelling)
        return Promise.reject(new Error("Update is not ready"));
      if (current.installPromise) return current.installPromise;
      current.installPromise = new Promise((resolve, reject) =>
        Object.assign(current, {
          resolveInstall: resolve,
          rejectInstall: reject,
        }),
      );
      current.timer = setTimeout(() => {
        current.rejectInstall(new Error("Install acknowledgement timed out"));
        void current.cancel();
      }, installTimeoutMs);
      current.timer.unref?.();
      current.child.stdin.write(`${JSON.stringify({ command: "install" })}\n`);
      return current.installPromise;
    },
    cancel: () => session?.cancel() || Promise.resolve(),
  };
}

module.exports = { createMacUpdateAdapter, MAC_UPDATE_FEED };
