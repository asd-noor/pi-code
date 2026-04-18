/**
 * LSP installer — discovers and installs language servers into
 * ~/.pi/cache/lsp/. No Bun APIs — pure Node.js.
 */

import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform, arch } from "node:os";
import { getLspDir, ensureDir } from "../paths.ts";

// ── which replacement ─────────────────────────────────────────────────────────

function which(cmd: string): string | null {
  try {
    const out = execFileSync("which", [cmd], { stdio: "pipe", timeout: 3000 });
    return out.toString().trim() || null;
  } catch { return null; }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InstallRecipe {
  serverId: string;
  displayName: string;
  systemBinary: string;
  localBinary(): string;
  install(lspDir: string): Promise<void>;
  hint: string;
}

// ── Recipes ───────────────────────────────────────────────────────────────────

const RECIPES: Record<string, InstallRecipe> = {
  "typescript-language-server": {
    serverId: "typescript-language-server",
    displayName: "typescript-language-server (TypeScript/JavaScript)",
    systemBinary: "typescript-language-server",
    localBinary: () => join(getLspDir(), "node_modules", ".bin", "typescript-language-server"),
    hint: "npm install -g typescript-language-server typescript",
    install: async (lspDir) => { runNpm(lspDir, "typescript-language-server", "typescript"); },
  },
  "pyright-langserver": {
    serverId: "pyright-langserver",
    displayName: "pyright (Python)",
    systemBinary: "pyright-langserver",
    localBinary: () => join(getLspDir(), "node_modules", ".bin", "pyright-langserver"),
    hint: "npm install -g pyright",
    install: async (lspDir) => { runNpm(lspDir, "pyright"); },
  },
  "pylsp": {
    serverId: "pylsp",
    displayName: "pylsp (Python)",
    systemBinary: "pylsp",
    localBinary: () => join(getLspDir(), "pylsp", "bin", "pylsp"),
    hint: "pip install python-lsp-server",
    install: async (lspDir) => {
      const venv = join(lspDir, "pylsp");
      runSync("python3", ["-m", "venv", venv]);
      runSync(join(venv, "bin", "pip"), ["install", "python-lsp-server"]);
    },
  },
  "gopls": {
    serverId: "gopls",
    displayName: "gopls (Go)",
    systemBinary: "gopls",
    localBinary: () => join(getLspDir(), "go", "bin", "gopls"),
    hint: "go install golang.org/x/tools/gopls@latest",
    install: async (lspDir) => {
      const goPath = join(lspDir, "go");
      mkdirSync(goPath, { recursive: true });
      runSync("go", ["install", "golang.org/x/tools/gopls@latest"], {
        env: { ...process.env, GOPATH: goPath },
      });
    },
  },
  "zls": {
    serverId: "zls",
    displayName: "zls (Zig)",
    systemBinary: "zls",
    localBinary: () => join(getLspDir(), "bin", "zls"),
    hint: "brew install zls  # or download from https://github.com/zigtools/zls/releases",
    install: async (_lspDir) => {
      throw new Error(
        "ZLS has no auto-install recipe — please install it manually:\n" +
        "  brew install zls\n" +
        "  or download a prebuilt binary from https://github.com/zigtools/zls/releases"
      );
    },
  },
  "lua-language-server": {
    serverId: "lua-language-server",
    displayName: "lua-language-server (Lua)",
    systemBinary: "lua-language-server",
    localBinary: () => join(getLspDir(), "bin", "lua-language-server"),
    hint: "brew install lua-language-server",
    install: async (lspDir) => {
      const binDir = join(lspDir, "bin");
      mkdirSync(binDir, { recursive: true });
      await downloadLuaLs(binDir);
    },
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

export function getInstalledBinary(serverId: string): string | null {
  const recipe = RECIPES[serverId];
  if (!recipe) return which(serverId);
  const local = recipe.localBinary();
  if (existsSync(local)) return local;
  return which(recipe.systemBinary);
}

export function isInstalled(serverId: string): boolean {
  return getInstalledBinary(serverId) !== null;
}

export function getInstallHint(serverId: string): string {
  return RECIPES[serverId]?.hint ?? `install ${serverId} and make sure it is on your PATH`;
}

export async function installServer(
  serverId: string,
  log: (msg: string) => void = console.log
): Promise<void> {
  const recipe = RECIPES[serverId];
  if (!recipe) throw new Error(`No install recipe for server: ${serverId}`);
  const lspDir = ensureDir(getLspDir());
  log(`Installing ${recipe.displayName}…`);
  await recipe.install(lspDir);
  const binary = recipe.localBinary();
  if (!existsSync(binary)) {
    throw new Error(`Install appeared to succeed but binary not found at: ${binary}`);
  }
  log(`Installed → ${binary}`);
}

export function knownServerIds(): string[] { return Object.keys(RECIPES); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function runNpm(lspDir: string, ...packages: string[]) {
  if (which("npm")) {
    runSync("npm", ["install", "--prefix", lspDir, ...packages]);
  } else if (which("bun")) {
    runSync("bun", ["add", "--cwd", lspDir, ...packages]);
  } else {
    throw new Error("Neither npm nor bun found on PATH");
  }
}

function runSync(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", env: opts.env ?? process.env });
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}`);
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const buf = await res.arrayBuffer();
  writeFileSync(dest, Buffer.from(buf));
}

async function downloadLuaLs(binDir: string): Promise<void> {
  const plat = platform();
  const ar   = arch();
  let suffix: string;
  if      (plat === "darwin" && ar === "arm64") suffix = "darwin-arm64.tar.gz";
  else if (plat === "darwin")                   suffix = "darwin-x64.tar.gz";
  else if (plat === "linux" && ar === "arm64")  suffix = "linux-arm64.tar.gz";
  else if (plat === "linux")                    suffix = "linux-x64.tar.gz";
  else throw new Error(`Unsupported platform for lua-language-server: ${plat}/${ar}`);
  const tag = await fetchLatestTag("LuaLS", "lua-language-server");
  const ver = tag.replace(/^v/, "");
  const url = `https://github.com/LuaLS/lua-language-server/releases/download/${tag}/lua-language-server-${ver}-${suffix}`;
  const tmpArchive = join(binDir, "_lua-ls.tar.gz");
  const tmpExtract = join(binDir, "_lua-ls");
  await downloadFile(url, tmpArchive);
  mkdirSync(tmpExtract, { recursive: true });
  runSync("tar", ["-xzf", tmpArchive, "-C", tmpExtract]);
  runSync("mv", [join(tmpExtract, "bin", "lua-language-server"), join(binDir, "lua-language-server")]);
  chmodSync(join(binDir, "lua-language-server"), 0o755);
  runSync("rm", ["-rf", tmpArchive, tmpExtract]);
}

async function fetchLatestTag(owner: string, repo: string): Promise<string> {
  const res  = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`,
    { headers: { "User-Agent": "pi-code-map" } });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const json = await res.json() as { tag_name: string };
  return json.tag_name;
}
