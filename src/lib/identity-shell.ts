import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Matches the HIVE shell-identity block in ~/.zshrc for idempotent upsert. */
export const IDENTITY_SHELL_PROFILE_REL =
  /# HIVE shell identity extension[\s\S]*?hive-identity-shell\.zsh[^\n]*\n/;

export function buildIdentityShellWrapperPath(home: string = process.env.HOME || homedir()): string {
  return join(home, ".hive", "bin", "hive-identity-shell.zsh");
}

export function renderIdentityShellWrapper(_opts: { home: string }): string {
  return `# HIVE shell identity extension — installed by hive init into ~/.hive/bin/
# Active when HIVE_SHELL_IDENTITY or HIVE_IDENTITY_POSTCMD_MARKER is set.
# hive -s launches: HIVE_SHELL_IDENTITY=1 HIVE_IDENTITY_POSTCMD_MARKER=1 zsh -lic

__hive_resolve_hive_bin() {
  if command -v hive >/dev/null 2>&1; then
    echo hive
    return 0
  fi
  if [[ -x "\${HOME}/.local/bin/hive" ]]; then
    echo "\${HOME}/.local/bin/hive"
    return 0
  fi
  return 1
}

__hive_identity_name() {
  local id_file="\${HIVE_HOME:-\${HOME}/.hive}/IDENTITY.md"
  local name=""
  if [[ -r "$id_file" ]]; then
    name=$(grep -m1 '^- Name:' "$id_file" 2>/dev/null | sed 's/^- Name:[[:space:]]*//;s/[[:space:]]*$//')
  fi
  [[ -n "$name" ]] && echo "$name" || echo "HIVE"
}

command __hive_ensure_identity_guides() {
  [[ -n "$HIVE_SHELL_IDENTITY" || -n "$HIVE_IDENTITY_POSTCMD_MARKER" ]] || return 0

  local name marker
  name=$(__hive_identity_name)
  marker="[\${name}]"

  case $PS1 in
    *"\${marker}"*) ;;
    *) PS1="\${marker} \${PS1:-%# }" ;;
  esac

  if [[ -z "$__hive_guides_shown" ]]; then
    __hive_guides_shown=1
    printf '\\033[2mHIVE shell · %s · %s\\033[0m\\n' "$name" "$(pwd)"
  fi
}

export -f __hive_ensure_identity_guides 2>/dev/null

__hive_identity_shell_active() {
  [[ -n "$HIVE_SHELL_IDENTITY" || -n "$HIVE_IDENTITY_POSTCMD_MARKER" ]]
}

if __hive_identity_shell_active; then
  autoload -Uz add-zsh-hook 2>/dev/null || true

  __hive_precmd_identity() {
    unset __hive_guides_shown
    __hive_ensure_identity_guides
  }

  __hive_postcmd_identity() {
    # $1 is the executed command line — re-show guides after each command so
    # arrow-up recall in direct mode still has visible identity context.
    if [[ -n "$HIVE_IDENTITY_POSTCMD_MARKER" ]]; then
      unset __hive_guides_shown
      __hive_ensure_identity_guides
    fi
  }

  __hive_chpwd_identity() {
    unset __hive_guides_shown
    __hive_ensure_identity_guides
  }

  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook precmd __hive_precmd_identity
    add-zsh-hook postcmd __hive_postcmd_identity
    add-zsh-hook chpwd __hive_chpwd_identity
  fi
fi
`;
}

export function expectedIdentityShellWrapperChecksum(): string {
  return createHash("sha256")
    .update(renderIdentityShellWrapper({ home: "/Users/test" }))
    .digest("hex");
}

function renderIdentityShellProfileBlock(wrapperPath: string): string {
  return `# HIVE shell identity extension (installed by hive init)
# hive -s launches an identity-aware login shell via: zsh -lic
[[ -f "${wrapperPath}" ]] && source "${wrapperPath}"
`;
}

export function upsertIdentityShellProfile(opts: {
  wrapperPath: string;
  profilePath: string;
}): string {
  let content = existsSync(opts.profilePath)
    ? readFileSync(opts.profilePath, "utf-8")
    : "";

  content = content.replace(IDENTITY_SHELL_PROFILE_REL, "").trimEnd();
  const block = renderIdentityShellProfileBlock(opts.wrapperPath);
  const finalText = content.length > 0 ? `${content}\n\n${block}` : block;
  const normalized = finalText.endsWith("\n") ? finalText : `${finalText}\n`;
  require("fs").writeFileSync(opts.profilePath, normalized);
  return normalized;
}

export async function writeIdentityShellWrapper(wrapperPath?: string): Promise<string> {
  const path = wrapperPath ?? buildIdentityShellWrapperPath();
  const home = process.env.HOME || homedir();
  const content = renderIdentityShellWrapper({ home });
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, content);
  await chmod(path, 0o644);
  return path;
}

export async function wireIdentityShell(opts: {
  profilePath?: string;
} = {}): Promise<{ wrapperWritten: boolean; profileUpdated: boolean }> {
  const wrapperPath = await writeIdentityShellWrapper();
  const profilePath = opts.profilePath ?? join(process.env.HOME || homedir(), ".zshrc");
  const before = existsSync(profilePath) ? await Bun.file(profilePath).text() : "";
  const after = upsertIdentityShellProfile({ wrapperPath, profilePath });
  return {
    wrapperWritten: true,
    profileUpdated: after !== before,
  };
}
