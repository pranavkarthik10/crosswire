// `crosswire service install` — keep the daemon alive from login onward.
// macOS: a launchd user agent. Linux: a systemd user unit. The daemon no
// longer belongs to any one repo, so the service runs it from $HOME and
// repos register themselves as you use the CLI in them.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LABEL = "dev.crosswire.daemon";

function plistPath() {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function systemdPath() {
  return join(homedir(), ".config", "systemd", "user", "crosswire.service");
}

export function serviceInstall(daemonArgv: string[], logPath: string): void {
  if (process.platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${daemonArgv.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${homedir()}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath(), plist);
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}`, plistPath()], { stdio: "ignore" });
    } catch {
      /* not loaded — fine */
    }
    execFileSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, plistPath()]);
    console.log(`installed launchd agent ${LABEL} — daemon now starts at login and stays up`);
  } else if (process.platform === "linux") {
    const unit = `[Unit]
Description=crosswire daemon

[Service]
ExecStart=${daemonArgv.join(" ")}
Restart=always
WorkingDirectory=${homedir()}

[Install]
WantedBy=default.target
`;
    mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    writeFileSync(systemdPath(), unit);
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", "crosswire.service"]);
    console.log("installed systemd user unit crosswire.service — daemon now starts at login and stays up");
  } else {
    console.log("service install is supported on macOS and Linux only");
  }
}

export function serviceUninstall(): void {
  if (process.platform === "darwin") {
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}`, plistPath()], { stdio: "ignore" });
    } catch {
      /* not loaded */
    }
    if (existsSync(plistPath())) unlinkSync(plistPath());
    console.log("launchd agent removed");
  } else if (process.platform === "linux") {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", "crosswire.service"], { stdio: "ignore" });
    } catch {
      /* not enabled */
    }
    if (existsSync(systemdPath())) unlinkSync(systemdPath());
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    console.log("systemd unit removed");
  } else {
    console.log("service uninstall is supported on macOS and Linux only");
  }
}
