import { useEffect, useRef, useState, type FormEvent } from "react";
import { FolderKey, Key, Plug, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AuthMethod, ConnectionProfile, HostKeyEvent, SessionInfo } from "../types";
import { ConnSteps } from "./ConnSteps";
import { HostKeyDialog } from "./HostKeyDialog";

type Progress = { stage: string; message: string };

type Props = {
  onClose: () => void;
  /** 新建连接并成功连上后回调 */
  onConnected?: (s: SessionInfo) => void;
  /** 编辑已有配置（不发起 SSH 连接） */
  editProfile?: ConnectionProfile;
  /** 保存 / 更新配置后刷新列表 */
  onProfileSaved?: () => void;
};

export function ConnectDialog({
  onClose,
  onConnected,
  editProfile,
  onProfileSaved,
}: Props) {
  const isEdit = Boolean(editProfile);

  const [name, setName] = useState(editProfile?.name ?? "");
  const [host, setHost] = useState(editProfile?.host ?? "");
  const [port, setPort] = useState(editProfile?.port ?? 22);
  const [user, setUser] = useState(editProfile?.user ?? "");
  const [authMethod, setAuthMethod] = useState<AuthMethod>(
    editProfile?.auth_method ?? "password"
  );
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState(
    editProfile?.private_key_path ?? ""
  );
  const [passphrase, setPassphrase] = useState("");
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connectId, setConnectId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [hostKey, setHostKey] = useState<HostKeyEvent | null>(null);
  const [hostKeyBusy, setHostKeyBusy] = useState(false);
  const hostKeyRef = useRef<HostKeyEvent | null>(null);

  useEffect(() => {
    if (!connectId) return;
    setProgress({ stage: "resolve", message: "开始连接…" });
    let unlistenProgress: (() => void) | undefined;
    let unlistenHostKey: (() => void) | undefined;
    listen<{ connect_id: string; stage: string; message: string }>(
      "ssh://progress",
      (e) => {
        if (e.payload.connect_id === connectId) {
          setProgress({ stage: e.payload.stage, message: e.payload.message });
        }
      }
    ).then((fn) => (unlistenProgress = fn));
    listen<HostKeyEvent>("ssh://hostkey", (e) => {
      if (e.payload.connectId === connectId) {
        hostKeyRef.current = e.payload;
        setHostKey(e.payload);
      }
    }).then((fn) => (unlistenHostKey = fn));
    return () => {
      unlistenProgress?.();
      unlistenHostKey?.();
    };
  }, [connectId]);

  async function pickPrivateKey() {
    try {
      const path = await invoke<string | null>("profile_select_private_key");
      if (path) setPrivateKeyPath(path);
    } catch (e) {
      setError(String(e));
    }
  }

  function validateForm(forConnect: boolean): string | null {
    if (!host.trim() || !user.trim()) return "请填写主机和用户";
    if (forConnect) {
      if (authMethod === "password" && !password && !isEdit) {
        return "请填写密码";
      }
      if (authMethod === "private_key" && !privateKeyPath.trim()) {
        return "请选择私钥文件";
      }
    }
    if (save && !name.trim()) return "保存连接需要填写名称";
    if (isEdit && authMethod === "private_key" && !privateKeyPath.trim()) {
      return "私钥认证需要指定私钥路径";
    }
    return null;
  }

  async function saveProfileOnly() {
    const payload = {
      name: name.trim(),
      host,
      port,
      user,
      authMethod,
      password: password || null,
      privateKeyPath: privateKeyPath || null,
      passphrase: passphrase || null,
    };
    if (isEdit && editProfile) {
      await invoke("profile_update", { id: editProfile.id, ...payload });
    } else {
      await invoke("profile_save", payload);
    }
    onProfileSaved?.();
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();

    if (isEdit) {
      const err = validateForm(false);
      if (err) {
        setError(err);
        return;
      }
      setBusy(true);
      setError("");
      try {
        await saveProfileOnly();
        onClose();
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
      return;
    }

    const err = validateForm(true);
    if (err) {
      setError(err);
      return;
    }

    setBusy(true);
    setError("");
    const id = crypto.randomUUID();
    setConnectId(id);
    try {
      const s = await invoke<SessionInfo>("ssh_connect", {
        connectId: id,
        host,
        port,
        user,
        authMethod,
        password: authMethod === "password" ? password : null,
        privateKeyPath: authMethod === "private_key" ? privateKeyPath : null,
        passphrase: authMethod === "private_key" ? passphrase || null : null,
      });
      if (save) await saveProfileOnly();
      onConnected?.(s);
    } catch (err) {
      if (hostKeyRef.current?.connectId === id) return;
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleHostKeyTrust() {
    if (!hostKey) return;
    setHostKeyBusy(true);
    try {
      await invoke("hostkey_trust", {
        host: hostKey.host,
        port: hostKey.port,
      });
      setHostKey(null);
      hostKeyRef.current = null;
      setHostKeyBusy(false);
      submit();
    } catch (err) {
      setHostKeyBusy(false);
      setError(String(err));
    }
  }

  async function handleHostKeyReject() {
    if (!hostKey) return;
    try {
      await invoke("hostkey_reject", {
        host: hostKey.host,
        port: hostKey.port,
      });
    } catch {
      /* 忽略 */
    }
    setHostKey(null);
    hostKeyRef.current = null;
    setError("已拒绝主机公钥，未连接。");
  }

  const canSubmit =
    host.trim() &&
    user.trim() &&
    (isEdit ||
      authMethod === "password" ||
      (authMethod === "private_key" && privateKeyPath.trim()));

  return (
    <>
      <div className="overlay" onClick={busy ? undefined : onClose}>
        <form
          className="dialog"
          onClick={(e) => e.stopPropagation()}
          onSubmit={submit}
        >
          <div className="dialog-head">
            <div className="dialog-title">
              <Plug size={16} /> {isEdit ? "编辑连接" : "新建连接"}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              disabled={busy}
            >
              <X size={16} />
            </button>
          </div>

          {busy && progress && !isEdit ? (
            <div className="conn-view">
              <div className="conn-spinner" />
              <div className="conn-msg">{progress.message}</div>
              <ConnSteps stage={progress.stage} />
            </div>
          ) : (
            <div className="dialog-body">
              <div className="row-2">
                <div className="field">
                  <label>主机</label>
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.10"
                    required
                    autoFocus
                  />
                </div>
                <div className="field">
                  <label>端口</label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value) || 22)}
                    min={1}
                    max={65535}
                  />
                </div>
              </div>
              <div className="field">
                <label>用户</label>
                <input
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder="root"
                  required
                />
              </div>

              <div className="field">
                <label>认证方式</label>
                <select
                  value={authMethod}
                  onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}
                >
                  <option value="password">密码</option>
                  <option value="private_key">SSH 私钥</option>
                </select>
              </div>

              {authMethod === "password" ? (
                <div className="field">
                  <label>密码{isEdit ? "（留空则不修改）" : ""}</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••"
                  />
                </div>
              ) : (
                <>
                  <div className="field">
                    <label>私钥文件</label>
                    <div className="key-row">
                      <input
                        value={privateKeyPath}
                        onChange={(e) => setPrivateKeyPath(e.target.value)}
                        placeholder="~/.ssh/id_ed25519"
                        className="key-path"
                      />
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={pickPrivateKey}
                        title="浏览选择私钥"
                      >
                        <FolderKey size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label>
                      私钥口令{isEdit ? "（留空则不修改）" : "（可选）"}
                    </label>
                    <input
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="加密私钥的 passphrase"
                    />
                  </div>
                </>
              )}

              <div className="field">
                <label>名称{isEdit ? "" : "（保存时用）"}</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="我的服务器"
                  disabled={!isEdit && !save}
                  required={isEdit}
                />
              </div>

              {!isEdit && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={save}
                    onChange={(e) => setSave(e.target.checked)}
                  />
                  保存这个连接（凭据存入系统钥匙串，不落明文）
                </label>
              )}

              {isEdit && editProfile?.auth_method === "private_key" && (
                <p className="auth-hint">
                  <Key size={12} /> 当前使用私钥认证
                  {editProfile.private_key_path
                    ? `：${editProfile.private_key_path}`
                    : ""}
                </p>
              )}
            </div>
          )}

          {error && <div className="dialog-error">{error}</div>}

          <div className="dialog-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !canSubmit}
            >
              {busy
                ? isEdit
                  ? "保存中…"
                  : "连接中…"
                : isEdit
                  ? "保存"
                  : "连接"}
            </button>
          </div>
        </form>
      </div>
      {hostKey && (
        <HostKeyDialog
          data={hostKey}
          busy={hostKeyBusy}
          onTrust={handleHostKeyTrust}
          onReject={handleHostKeyReject}
        />
      )}
    </>
  );
}
