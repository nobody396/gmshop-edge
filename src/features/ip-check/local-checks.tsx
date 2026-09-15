import { m } from "#/paraglide/messages";
// Read-only diagnostics: never print values, proxy URLs, API keys or config bodies.
export const localChecksCommand = `node <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');
const keys = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','ANTHROPIC_BASE_URL'];
for (const key of keys) console.log(key + ': ' + (process.env[key] ? 'SET' : 'NOT SET'));
console.log('Timezone: ' + Intl.DateTimeFormat().resolvedOptions().timeZone);
try {
  const config = JSON.parse(fs.readFileSync(os.homedir() + '/.claude/settings.json', 'utf8'));
  for (const key of keys) console.log('Claude config ' + key + ': ' + (config.env?.[key] ? 'SET' : 'NOT SET'));
} catch { console.log('Claude config: unavailable or invalid'); }
if (process.platform === 'darwin') {
  try {
    const proxy = cp.execFileSync('scutil', ['--proxy'], {encoding:'utf8',stdio:['ignore','pipe','ignore']});
    for (const key of ['HTTPEnable','HTTPSEnable','SOCKSEnable']) console.log(key + ': ' + (new RegExp(key + ' : 1').test(proxy) ? 'ENABLED' : 'NOT ENABLED'));
  } catch { console.log('System proxy: unavailable'); }
}
for (const key of ['http.proxy','https.proxy']) {
  try { const value=cp.execFileSync('git',['config','--global','--get',key],{encoding:'utf8',stdio:['ignore','pipe','ignore']});console.log('Git '+key+': '+(value.trim()?'SET':'NOT SET')); }
  catch { console.log('Git '+key+': not set or unavailable'); }
}
NODE`;
export const windowsChecksCommand = `$keys = 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','ANTHROPIC_BASE_URL'
foreach ($key in $keys) {
  $state = if ([Environment]::GetEnvironmentVariable($key)) { 'SET' } else { 'NOT SET' }
  Write-Output ($key + ': ' + $state)
}
Get-TimeZone | Select-Object -ExpandProperty Id`;

export function LocalChecks() {
	return (
		<div className="space-y-3">
			{[
				[m.ip_shell_unix(), localChecksCommand],
				[m.ip_shell_windows(), windowsChecksCommand],
			].map(([label, command]) => (
				<details key={label} className="rounded-xl border bg-muted/30 p-4">
					<summary className="cursor-pointer rounded font-medium text-sm focus-visible:outline-2">
						{label}
					</summary>
					<pre className="mt-4 overflow-x-auto text-xs leading-6">
						<code>{command}</code>
					</pre>
				</details>
			))}
		</div>
	);
}
