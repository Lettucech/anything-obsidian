// OS service-file encoders. Lifecycle ownership lives in services.mjs.
export function buildPlistXml({ label, programArguments, logPath, environment = {} }) {
  const escape = (value) =>
    String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const args = programArguments.map((arg) => `    <string>${escape(arg)}</string>`).join("\n");
  const envEntries = Object.entries(environment)
    .map(
      ([key, value]) => `      <key>${escape(key)}</key>\n      <string>${escape(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
</dict>
</plist>
`;
}

export function buildUnitFile({ description, programArguments, logPath, environment = {} }) {
  const args = programArguments
    .map((arg) => JSON.stringify(arg.replaceAll("%", "%%").replaceAll("$", () => "$$")))
    .join(" ");
  const envLines = Object.entries(environment)
    .map(([key, value]) => `Environment=${JSON.stringify(`${key}=${value}`.replaceAll("%", "%%"))}`)
    .join("\n");
  return `[Unit]
Description=${description}

[Service]
Type=simple
ExecStart=${args}
Restart=always
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}
${envLines}

[Install]
WantedBy=default.target
`;
}
