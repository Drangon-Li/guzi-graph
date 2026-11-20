import { useEffect, useState } from "react";

import { Button } from "@excalidraw/excalidraw";

import type { DesktopLanguage } from "../../shared/i18n/i18n";
import type {
  CloudState,
  CloudToken,
  CreatedCloudToken,
} from "../../../shared/desktop-api";

const labels = {
  "zh-CN": {
    title: "谷子云端 MCP",
    intro:
      "登录谷子账号后，AI 客户端用固定地址和你的 token 就能操作这台电脑上的画布，不需要开放本机端口。使用时请保持谷子画图打开。",
    status: {
      signed_out: "未登录",
      disabled: "已关闭",
      idle: "未连接",
      connecting: "连接中",
      online: "在线",
      reconnecting: "重新连接中",
      error: "出错",
    },
    enable: "启用云端 MCP",
    login: "登录",
    loginCode: "验证码登录",
    register: "注册",
    identifier: "账号 / 邮箱",
    password: "密码",
    email: "邮箱",
    code: "验证码",
    username: "账号名",
    usernameHint: "3–32 位，以字母开头，可用字母、数字、下划线和连字符。",
    passwordHint: "至少 8 位，需同时包含字母和数字。",
    sendCode: "发送验证码",
    resend: (seconds: number) => `${seconds} 秒后重发`,
    codeSent: "验证码已发送，请查收邮件。",
    submitLogin: "登录",
    submitRegister: "注册并登录",
    signedInAs: "已登录",
    logout: "退出登录",
    manage: "在网页上管理账号",
    endpoint: "地址",
    copy: "复制",
    copied: "已复制",
    copyFailed: "复制失败，请检查剪贴板权限。",
    tokens: "访问 token",
    tokensHint:
      "每个 token 只能访问谷子画图。把 token 交给你信任的 AI 客户端；不用时删除即可立刻失效。",
    noTokens: "还没有 token。",
    tokenName: "名称",
    tokenPlaceholder: "例如：工作电脑上的 Claude Code",
    bindDevice: "只转发到这台电脑",
    create: "新建 token",
    delete: "删除",
    lastUsed: "最近使用",
    never: "从未",
    onlyThisDevice: "仅这台电脑",
    createdTitle: "token 已创建",
    createdWarning:
      "这是唯一一次显示完整 token，请现在复制保存。之后只能删除重建。",
    copyToken: "复制 token",
    copyClaude: "复制 Claude Code 命令",
    copyJson: "复制 JSON 配置",
    copyCodex: "复制 Codex 配置",
    done: "完成",
    forgot: "忘记密码请在网页上找回。",
  },
  en: {
    title: "Guzi Cloud MCP",
    intro:
      "Sign in with your Guzi account and AI clients can reach the canvases on this computer through a fixed address and your token — no local port required. Keep Guzi Graph open while you use it.",
    status: {
      signed_out: "Signed out",
      disabled: "Off",
      idle: "Not connected",
      connecting: "Connecting",
      online: "Online",
      reconnecting: "Reconnecting",
      error: "Error",
    },
    enable: "Enable cloud MCP",
    login: "Sign in",
    loginCode: "Email code",
    register: "Create account",
    identifier: "Username / email",
    password: "Password",
    email: "Email",
    code: "Code",
    username: "Username",
    usernameHint:
      "3–32 characters, starts with a letter; letters, digits, _ and - only.",
    passwordHint: "At least 8 characters with both letters and digits.",
    sendCode: "Send code",
    resend: (seconds: number) => `Resend in ${seconds}s`,
    codeSent: "Code sent. Check your inbox.",
    submitLogin: "Sign in",
    submitRegister: "Create and sign in",
    signedInAs: "Signed in as",
    logout: "Sign out",
    manage: "Manage account on the web",
    endpoint: "Endpoint",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed. Check clipboard permission.",
    tokens: "Access tokens",
    tokensHint:
      "Each token can only reach Guzi Graph. Give it to AI clients you trust; delete it to revoke access immediately.",
    noTokens: "No tokens yet.",
    tokenName: "Name",
    tokenPlaceholder: "e.g. Claude Code on my work laptop",
    bindDevice: "Only forward to this computer",
    create: "New token",
    delete: "Delete",
    lastUsed: "Last used",
    never: "never",
    onlyThisDevice: "this computer only",
    createdTitle: "Token created",
    createdWarning:
      "This is the only time the full token is shown. Copy it now; later you can only delete and recreate it.",
    copyToken: "Copy token",
    copyClaude: "Copy Claude Code command",
    copyJson: "Copy JSON config",
    copyCodex: "Copy Codex config",
    done: "Done",
    forgot: "Forgot your password? Reset it on the web.",
  },
};

/** IPC 错误会带上 "Error invoking remote method …: Error: " 前缀，只保留服务端给出的提示。 */
export const cloudErrorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/,
    "",
  );

const formatTime = (value: number | null, never: string) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      })
    : never;

type AuthMode = "login" | "code" | "register";

export const CloudMcpCard = ({
  root,
  language,
}: {
  root: HTMLElement;
  language: DesktopLanguage;
}) => {
  const L = labels[language];
  const view = root.ownerDocument.defaultView!;
  const desktop = view.desktop;
  const [state, setState] = useState<CloudState | null>(null);
  const [mode, setMode] = useState<AuthMode>("login");
  const [form, setForm] = useState({
    identifier: "",
    password: "",
    email: "",
    code: "",
    username: "",
  });
  const [cooldown, setCooldown] = useState(0);
  const [tokens, setTokens] = useState<CloudToken[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [bindDevice, setBindDevice] = useState(false);
  const [created, setCreated] = useState<CreatedCloudToken | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let mounted = true;
    const unsubscribe = desktop.onCloudState((next) => setState(next));
    desktop.getCloudState().then(
      (next) => mounted && setState(next),
      (cause) => mounted && setError(cloudErrorMessage(cause)),
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [desktop]);

  const signedIn = !!state?.signedIn;
  useEffect(() => {
    if (!signedIn) {
      setTokens([]);
      return;
    }
    void desktop
      .listCloudTokens()
      .then(setTokens)
      .catch(() => setTokens([]));
  }, [desktop, signedIn]);

  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const timer = view.setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => view.clearTimeout(timer);
  }, [cooldown, view]);

  const run = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    setFeedback("");
    try {
      await operation();
    } catch (cause) {
      setError(cloudErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const copy = async (value: string) => {
    setFeedback("");
    try {
      await view.navigator.clipboard.writeText(value);
      setFeedback(L.copied);
    } catch {
      setError(L.copyFailed);
    }
  };

  const field =
    (key: keyof typeof form) => (event: { currentTarget: { value: string } }) =>
      setForm({ ...form, [key]: event.currentTarget.value });

  const sendCode = () =>
    run(async () => {
      const result = await desktop.requestCloudCode({
        purpose: mode === "register" ? "register" : "login",
        email: form.email.trim(),
      });
      setCooldown(result.cooldownSeconds || 60);
      setFeedback(L.codeSent);
    });

  const submit = () =>
    run(async () => {
      if (mode === "login") {
        await desktop.cloudLogin({
          identifier: form.identifier.trim(),
          password: form.password,
        });
      } else if (mode === "code") {
        await desktop.cloudLoginWithCode({
          email: form.email.trim(),
          code: form.code.trim(),
        });
      } else {
        await desktop.cloudRegister({
          username: form.username.trim(),
          password: form.password,
          email: form.email.trim(),
          code: form.code.trim(),
        });
      }
      setForm({
        identifier: "",
        password: "",
        email: "",
        code: "",
        username: "",
      });
    });

  const refreshTokens = async () => setTokens(await desktop.listCloudTokens());

  const status = state?.connection ?? "signed_out";
  const statusClass =
    status === "online" ? "is-running" : status === "error" ? "is-error" : "";

  return (
    <article className="desktop-market-card desktop-cloud" aria-label={L.title}>
      <header>
        <div>
          <h2>{L.title}</h2>
          <span
            className={`desktop-plugin-status ${statusClass}`}
            role="status"
          >
            {L.status[status]}
          </span>
        </div>
        {signedIn && (
          <label className="desktop-plugin-toggle">
            <input
              type="checkbox"
              role="switch"
              aria-label={L.enable}
              checked={!!state?.enabled}
              disabled={pending}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                void run(() => desktop.setCloudEnabled(enabled));
              }}
            />
            {L.enable}
          </label>
        )}
      </header>
      <p>{L.intro}</p>
      {state?.error && <p role="alert">{state.error}</p>}

      {!signedIn && (
        <section className="desktop-cloud-auth">
          <div className="desktop-cloud-tabs" role="tablist">
            {(["login", "code", "register"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mode === item}
                onClick={() => {
                  setMode(item);
                  setError("");
                  setFeedback("");
                }}
              >
                {item === "login"
                  ? L.login
                  : item === "code"
                  ? L.loginCode
                  : L.register}
              </button>
            ))}
          </div>
          <form
            className="desktop-cloud-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {mode === "login" && (
              <>
                <label>
                  <span>{L.identifier}</span>
                  <input
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={form.identifier}
                    onChange={field("identifier")}
                    required
                  />
                </label>
                <label>
                  <span>{L.password}</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={form.password}
                    onChange={field("password")}
                    required
                  />
                </label>
              </>
            )}
            {mode !== "login" && (
              <>
                <label>
                  <span>{L.email}</span>
                  <input
                    type="email"
                    autoComplete="email"
                    value={form.email}
                    onChange={field("email")}
                    required
                  />
                </label>
                <label>
                  <span>{L.code}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="one-time-code"
                    value={form.code}
                    onChange={field("code")}
                    required
                  />
                  <Button
                    onSelect={() => void sendCode()}
                    disabled={pending || cooldown > 0 || !form.email.trim()}
                  >
                    {cooldown > 0 ? L.resend(cooldown) : L.sendCode}
                  </Button>
                </label>
              </>
            )}
            {mode === "register" && (
              <>
                <label>
                  <span>{L.username}</span>
                  <input
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={form.username}
                    onChange={field("username")}
                    required
                  />
                </label>
                <p className="desktop-market-hint">{L.usernameHint}</p>
                <label>
                  <span>{L.password}</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={field("password")}
                    required
                  />
                </label>
                <p className="desktop-market-hint">{L.passwordHint}</p>
              </>
            )}
            <div className="desktop-plugin-copy-actions">
              <Button
                type="submit"
                onSelect={() => undefined}
                disabled={pending}
              >
                {mode === "register" ? L.submitRegister : L.submitLogin}
              </Button>
              <Button
                onSelect={() => void desktop.openCloudAccount()}
                disabled={pending}
              >
                {L.manage}
              </Button>
            </div>
            {mode === "login" && (
              <p className="desktop-market-hint">{L.forgot}</p>
            )}
          </form>
        </section>
      )}

      {signedIn && state && (
        <section className="desktop-plugin-connection">
          <div className="desktop-plugin-value">
            <span>{L.signedInAs}</span>
            <code>
              {state.user?.username}
              {state.user?.email ? `（${state.user.email}）` : ""}
            </code>
            <Button onSelect={() => void desktop.openCloudAccount()}>
              {L.manage}
            </Button>
            <Button
              onSelect={() => void run(() => desktop.cloudLogout())}
              disabled={pending}
            >
              {L.logout}
            </Button>
          </div>
          <div className="desktop-plugin-value">
            <span>{L.endpoint}</span>
            <code>{state.endpoint}</code>
            <Button onSelect={() => void copy(state.endpoint)}>{L.copy}</Button>
          </div>

          <h3>{L.tokens}</h3>
          <p className="desktop-market-hint">{L.tokensHint}</p>
          {tokens.length === 0 && (
            <p className="desktop-market-hint">{L.noTokens}</p>
          )}
          <ul className="desktop-cloud-tokens">
            {tokens.map((token) => (
              <li key={token.id}>
                <div>
                  <strong>{token.name}</strong>
                  {token.deviceId === state.deviceId && (
                    <small> · {L.onlyThisDevice}</small>
                  )}
                  <div className="desktop-market-hint">
                    <code>{token.hint}</code> · {L.lastUsed}{" "}
                    {formatTime(token.lastUsedAt, L.never)}
                  </div>
                </div>
                <Button
                  onSelect={() =>
                    void run(async () => {
                      await desktop.revokeCloudToken(token.id);
                      await refreshTokens();
                    })
                  }
                  disabled={pending}
                >
                  {L.delete}
                </Button>
              </li>
            ))}
          </ul>

          {created ? (
            <div className="desktop-cloud-created" role="region">
              <h3>{L.createdTitle}</h3>
              <p role="alert" className="desktop-cloud-warning">
                {L.createdWarning}
              </p>
              <pre>
                <code>{created.token}</code>
              </pre>
              <div className="desktop-plugin-copy-actions">
                <Button onSelect={() => void copy(created.token)}>
                  {L.copyToken}
                </Button>
                <Button onSelect={() => void copy(created.configs.claudeCode)}>
                  {L.copyClaude}
                </Button>
                <Button onSelect={() => void copy(created.configs.json)}>
                  {L.copyJson}
                </Button>
                <Button onSelect={() => void copy(created.configs.codex)}>
                  {L.copyCodex}
                </Button>
                <Button onSelect={() => setCreated(null)}>{L.done}</Button>
              </div>
            </div>
          ) : (
            <form
              className="desktop-cloud-form desktop-cloud-create"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  setCreated(
                    await desktop.createCloudToken({
                      name: tokenName.trim(),
                      bindDevice,
                    }),
                  );
                  setTokenName("");
                  await refreshTokens();
                });
              }}
            >
              <label>
                <span>{L.tokenName}</span>
                <input
                  type="text"
                  maxLength={48}
                  placeholder={L.tokenPlaceholder}
                  value={tokenName}
                  onChange={(event) => setTokenName(event.currentTarget.value)}
                  required
                />
              </label>
              <label className="desktop-cloud-check">
                <input
                  type="checkbox"
                  checked={bindDevice}
                  onChange={(event) =>
                    setBindDevice(event.currentTarget.checked)
                  }
                />
                {L.bindDevice}
              </label>
              <Button
                type="submit"
                onSelect={() => undefined}
                disabled={pending || !tokenName.trim()}
              >
                {L.create}
              </Button>
            </form>
          )}
        </section>
      )}
      <p role="status" className="desktop-market-hint">
        {feedback}
      </p>
      {error && <p role="alert">{error}</p>}
    </article>
  );
};
