//! 连接配置导入。
//!
//! 当前实现：自解析 `~/.ssh/config`（覆盖最常见的 Host/HostName/Port/User/IdentityFile）。
//! Xshell `.xsh` / SecureCRT `.ini`（ini 格式）后续用 `rust-ini` 补。

use std::collections::HashMap;

use super::profile::{AuthMethod, ProfileInput};

pub fn read_ssh_config_with_includes(path: &std::path::Path) -> Result<String, String> {
    fn read(
        path: &std::path::Path,
        visited: &mut std::collections::HashSet<std::path::PathBuf>,
        depth: usize,
    ) -> Result<String, String> {
        if depth > 8 {
            return Err("SSH Config Include 嵌套超过 8 层".into());
        }
        let canonical = std::fs::canonicalize(path)
            .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
        if !visited.insert(canonical.clone()) {
            return Ok(String::new());
        }
        let content = std::fs::read_to_string(&canonical)
            .map_err(|error| format!("读取 {} 失败：{error}", canonical.display()))?;
        let base = canonical
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."));
        let mut output = String::new();
        for raw in content.lines() {
            let trimmed = raw.trim();
            let include = split_kv(trimmed)
                .filter(|(key, _)| key == "include")
                .map(|(_, value)| value);
            if let Some(include) = include {
                for pattern in include.split_whitespace() {
                    let expanded = expand_tilde(pattern);
                    let candidate = std::path::PathBuf::from(expanded);
                    let pattern = if candidate.is_absolute() {
                        candidate
                    } else {
                        base.join(candidate)
                    };
                    let mut matches = glob::glob(&pattern.to_string_lossy())
                        .map_err(|error| format!("Include 模式无效：{error}"))?
                        .filter_map(Result::ok)
                        .collect::<Vec<_>>();
                    matches.sort();
                    for included in matches {
                        output.push_str(&read(&included, visited, depth + 1)?);
                        output.push('\n');
                    }
                }
            } else {
                output.push_str(raw);
                output.push('\n');
            }
        }
        Ok(output)
    }
    read(path, &mut std::collections::HashSet::new(), 0)
}

/// 解析 `~/.ssh/config` 文本，返回可导入的 [`ProfileInput`] 列表。
///
/// 支持 OpenSSH 常见的“先匹配值生效”继承、一个 Host 中的多个别名和 ProxyJump
/// 别名。通配符块不会自己生成连接，但会为匹配的具体别名提供默认值。
pub fn parse_ssh_config(content: &str) -> Vec<ProfileInput> {
    #[derive(Default)]
    struct Block {
        patterns: Vec<String>,
        values: HashMap<String, String>,
    }
    let mut blocks = vec![Block::default()];
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
                blocks.push(Block {
                    patterns: value.split_whitespace().map(str::to_string).collect(),
                    values: HashMap::new(),
                });
            }
            "hostname" | "port" | "user" | "identityfile" | "proxyjump" | "serveraliveinterval" => {
                blocks
                    .last_mut()
                    .expect("global block exists")
                    .values
                    .entry(key)
                    .or_insert(value);
            }
            _ => { /* unsupported directives are intentionally ignored by this compatibility layer */
            }
        }
    }

    let aliases = blocks
        .iter()
        .flat_map(|block| &block.patterns)
        .filter(|alias| !alias.starts_with('!') && !alias.contains(['*', '?']))
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let mut result = Vec::new();
    for alias in aliases {
        let mut values = HashMap::new();
        for block in &blocks {
            if block.patterns.is_empty() || block_matches(&block.patterns, &alias) {
                for (key, value) in &block.values {
                    values.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
        }
        let private_key_path = values.get("identityfile").map(|value| expand_tilde(value));
        let jump_profile_id = values.get("proxyjump").and_then(|value| {
            let target = value.split(',').next()?.trim();
            if target.is_empty() || target.eq_ignore_ascii_case("none") {
                return None;
            }
            let host = target.rsplit('@').next().unwrap_or(target);
            Some(format!("ssh-config:{host}"))
        });
        let input = ProfileInput {
            name: alias.clone(),
            host: values.get("hostname").cloned().unwrap_or(alias),
            port: values
                .get("port")
                .and_then(|value| value.parse().ok())
                .unwrap_or(22),
            user: values.get("user").cloned().unwrap_or_default(),
            auth_method: if private_key_path.is_some() {
                AuthMethod::PrivateKey
            } else {
                AuthMethod::Password
            },
            password: None,
            private_key_path,
            passphrase: None,
            group_id: None,
            jump_profile_id,
            encoding: None,
            keepalive_interval: values
                .get("serveraliveinterval")
                .and_then(|value| value.parse().ok()),
            startup_command: None,
            environment: None,
        };
        push_if_complete(&mut result, input);
    }
    result
}

fn block_matches(patterns: &[String], alias: &str) -> bool {
    let excluded = patterns
        .iter()
        .filter_map(|pattern| pattern.strip_prefix('!'))
        .any(|pattern| wildcard_match(pattern, alias));
    !excluded
        && patterns
            .iter()
            .filter(|pattern| !pattern.starts_with('!'))
            .any(|pattern| wildcard_match(pattern, alias))
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let (pattern, text) = (pattern.as_bytes(), text.as_bytes());
    let (mut p, mut t, mut star, mut checkpoint) = (0, 0, None, 0);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p].eq_ignore_ascii_case(&text[t])) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            checkpoint = t;
        } else if let Some(index) = star {
            p = index + 1;
            checkpoint += 1;
            t = checkpoint;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
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
        // 通配符 Host * 被跳过，但为 web2 提供 user 默认值（web2 自己已声明 root）。
        assert!(parsed.iter().all(|p| !p.name.contains('*')));
    }

    #[test]
    fn applies_wildcard_defaults_and_proxy_jump_alias() {
        let cfg = "Host app\n  HostName 10.0.0.2\n  ProxyJump bastion\nHost bastion\n  HostName 10.0.0.1\nHost *\n  User deploy\n  ServerAliveInterval 20\n";
        let parsed = parse_ssh_config(cfg);
        let app = parsed.iter().find(|item| item.name == "app").unwrap();
        assert_eq!(app.user, "deploy");
        assert_eq!(app.keepalive_interval, Some(20));
        assert_eq!(app.jump_profile_id.as_deref(), Some("ssh-config:bastion"));
    }

    #[test]
    fn expands_relative_include_once() {
        let root = std::env::temp_dir().join(format!("simpl-ssh-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("conf.d")).unwrap();
        std::fs::write(
            root.join("config"),
            "Include conf.d/*.conf\nHost *\n User deploy\n",
        )
        .unwrap();
        std::fs::write(
            root.join("conf.d/app.conf"),
            "Host app\n HostName 10.0.0.3\n",
        )
        .unwrap();
        let content = read_ssh_config_with_includes(&root.join("config")).unwrap();
        let parsed = parse_ssh_config(&content);
        assert_eq!(parsed[0].name, "app");
        assert_eq!(parsed[0].user, "deploy");
        let _ = std::fs::remove_dir_all(root);
    }
}
