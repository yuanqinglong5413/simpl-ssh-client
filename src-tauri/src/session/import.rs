//! 连接配置导入。
//!
//! 当前实现：自解析 `~/.ssh/config`（覆盖最常见的 Host/HostName/Port/User/IdentityFile）。
//! Xshell `.xsh` / SecureCRT `.ini`（ini 格式）后续用 `rust-ini` 补。

use super::profile::{AuthMethod, ProfileInput};

/// 解析 `~/.ssh/config` 文本，返回可导入的 [`ProfileInput`] 列表。
///
/// 仅处理常见字段；通配符主机（`Host *`）跳过；`ProxyJump` 暂不自动关联
///（需匹配已保存的跳板 profile，导入后由用户手动设置）。
pub fn parse_ssh_config(content: &str) -> Vec<ProfileInput> {
    let mut result: Vec<ProfileInput> = Vec::new();
    let mut pending: Option<ProfileInput> = None;
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = split_kv(line) else {
            continue;
        };
        match key.as_str() {
            "host" => {
                if let Some(p) = pending.take() {
                    push_if_complete(&mut result, p);
                }
                let alias = value.split_whitespace().next().unwrap_or("").to_string();
                pending = if alias.contains('*') || alias.contains('?') {
                    None
                } else {
                    Some(ProfileInput {
                        name: alias.clone(),
                        host: alias,
                        port: 22,
                        user: String::new(),
                        auth_method: AuthMethod::Password,
                        password: None,
                        private_key_path: None,
                        passphrase: None,
                        group_id: None,
                        jump_profile_id: None,
                        encoding: None,
                        keepalive_interval: None,
                        startup_command: None,
                        environment: None,
                    })
                };
            }
            "hostname" => {
                if let Some(p) = pending.as_mut() {
                    p.host = value;
                }
            }
            "port" => {
                if let (Some(p), Ok(n)) = (pending.as_mut(), value.parse::<u16>()) {
                    p.port = n;
                }
            }
            "user" => {
                if let Some(p) = pending.as_mut() {
                    p.user = value;
                }
            }
            "identityfile" => {
                if let Some(p) = pending.as_mut() {
                    p.auth_method = AuthMethod::PrivateKey;
                    p.private_key_path = Some(expand_tilde(&value));
                }
            }
            _ => {}
        }
    }
    if let Some(p) = pending {
        push_if_complete(&mut result, p);
    }
    result
}

/// 拆 `Key Value` 为小写 key 与 trimmed value。
fn split_kv(line: &str) -> Option<(String, String)> {
    let (k, v) = line.split_once(char::is_whitespace)?;
    Some((k.to_ascii_lowercase(), v.trim().to_string()))
}

/// 仅保留有 host 且有 user 的条目（避免导入不完整项）。
fn push_if_complete(out: &mut Vec<ProfileInput>, p: ProfileInput) {
    if !p.host.is_empty() && !p.user.is_empty() {
        out.push(p);
    }
}

/// `~/foo` → `/home/user/foo`。
fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_hosts() {
        let cfg = "\
Host web1\n\
  HostName 10.0.0.1\n\
  Port 2222\n\
  User admin\n\
  IdentityFile ~/.ssh/id_ed25519\n\
Host *\n\
  User fallback\n\
Host web2\n\
  HostName 10.0.0.2\n\
  User root\n";
        let parsed = parse_ssh_config(cfg);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].host, "10.0.0.1");
        assert_eq!(parsed[0].port, 2222);
        assert_eq!(parsed[0].user, "admin");
        assert_eq!(parsed[0].auth_method, AuthMethod::PrivateKey);
        assert!(parsed[0]
            .private_key_path
            .as_deref()
            .unwrap()
            .ends_with("id_ed25519"));
        assert_eq!(parsed[1].host, "10.0.0.2");
        // 通配符 Host * 被跳过
        assert!(parsed.iter().all(|p| !p.name.contains('*')));
    }
}
