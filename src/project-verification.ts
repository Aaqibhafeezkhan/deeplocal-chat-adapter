export type VerificationCategory = 'lint' | 'typecheck' | 'build' | 'test';
export interface ProjectPackageManifest { path: string; scripts: Record<string, unknown>; }
export interface VerificationCommand {
  category: VerificationCategory; command: string; args: string[]; project: string;
  source: 'package-script' | 'project-config'; script?: string;
}
export interface ProjectVerificationReport {
  preferences: VerificationCategory[];
  commands: VerificationCommand[];
  missing: Array<{ project: string; category: VerificationCategory }>;
  skippedUnsafe: Array<{ project: string; script: string; reason: string }>;
  inspected: string[];
  note: string;
}
const categories: VerificationCategory[] = ['lint', 'typecheck', 'build', 'test'];
const aliases: Record<VerificationCategory, string[]> = {
  lint: ['lint', 'lint:check', 'check:lint', 'eslint'],
  typecheck: ['typecheck', 'type-check', 'check-types', 'check:types', 'type-checks', 'tsc'],
  build: ['build', 'compile', 'check:build', 'build:check'],
  test: ['test', 'test:unit', 'test:ci', 'unit', 'check:test'],
};
const unsafeScriptName = /(?:^|[:_-])(install|uninstall|publish|deploy|release|migrate|destroy|clean|reset|teardown|remove|delete)(?:$|[:_-])/i;
const unsafeScriptBody = /\b(?:npm|pnpm|yarn)\s+(?:(?:run\s+)?(?:install|add|publish|deploy|release)|(?:exec|dlx)\s+)/i;
const unsafeCommandBody = /\b(?:git\s+push|terraform\s+apply|kubectl\s+delete|docker\s+push)\b|\b(?:rm|rmdir|del|Remove-Item|npx)\b|\b(?:pip3?|uv|poetry)\s+(?:install|add|sync)\b|\b(?:drop|truncate)\s+(?:database|table)\b|\|\s*(?:sh|bash)\b/i;
export function isUnsafeVerificationScript(name: string, body: string, scripts: Record<string, string> = {}, visited = new Set<string>()): boolean {
  if (unsafeScriptName.test(name) || unsafeScriptBody.test(body) || unsafeCommandBody.test(body)) return true;
  if (visited.has(name)) return true;
  const ancestors = new Set(visited).add(name);
  for (const lifecycle of [`pre${name}`, `post${name}`]) {
    const lifecycleBody = scripts[lifecycle];
    if (lifecycleBody && isUnsafeVerificationScript(lifecycle, lifecycleBody, scripts, ancestors)) return true;
  }
  const packageCalls = [...body.matchAll(/\b(npm|pnpm|yarn)(?:\.cmd)?\s+(?:(run|run-script)\s+)?([a-zA-Z0-9:_-]+)/gi)];
  // Options or dynamic shell syntax can hide a different package/directory.
  // Treat an invocation we cannot inspect as requiring approval.
  if (packageCalls.length !== [...body.matchAll(/\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+/gi)].length) return true;
  for (const match of packageCalls) {
    const delegatedName = match[3];
    if (match[1].toLowerCase() === 'npm' && !match[2] && !['test', 'start', 'stop', 'restart'].includes(delegatedName)) return true;
    const delegatedBody = scripts[delegatedName];
    if (unsafeScriptName.test(delegatedName) || delegatedBody === undefined || isUnsafeVerificationScript(delegatedName, delegatedBody, scripts, ancestors)) return true;
  }
  return false;
}
function packageManager(manifest: string, files: Record<string, string>): string {
  let directory = projectDirectory(manifest);
  while (true) {
    const has = (name: string) => Object.prototype.hasOwnProperty.call(files, [directory, name].filter(Boolean).join('/'));
    if (has('pnpm-lock.yaml')) return 'pnpm';
    if (has('yarn.lock')) return 'yarn';
    if (has('package-lock.json')) return 'npm';
    if (!directory) return 'npm';
    directory = projectDirectory(directory);
  }
}
function projectDirectory(file: string): string { const index = file.lastIndexOf('/'); return index < 0 ? '' : file.slice(0, index); }
function packageScriptArgs(manager: string, manifest: string, script: string): string[] {
  const directory = projectDirectory(manifest);
  if (!directory) return ['run', script];
  if (manager === 'pnpm') return ['--dir', directory, 'run', script];
  if (manager === 'yarn') return ['--cwd', directory, 'run', script];
  return ['--prefix', directory, 'run', script];
}
function configCommands(files: Record<string, string>): VerificationCommand[] {
  const commands: VerificationCommand[] = [];
  const entries = Object.keys(files);
  for (const project of entries.filter(file => /(?:^|\/)Cargo\.toml$/.test(file))) {
    commands.push({ category: 'lint', command: 'cargo', args: ['fmt', '--manifest-path', project, '--', '--check'], project, source: 'project-config' });
    commands.push({ category: 'typecheck', command: 'cargo', args: ['check', '--manifest-path', project], project, source: 'project-config' });
    commands.push({ category: 'test', command: 'cargo', args: ['test', '--manifest-path', project], project, source: 'project-config' });
  }
  for (const project of entries.filter(file => /(?:^|\/)go\.mod$/.test(file))) {
    const prefix = projectDirectory(project) ? ['-C', projectDirectory(project)] : [];
    commands.push({ category: 'lint', command: 'go', args: [...prefix, 'vet', './...'], project, source: 'project-config' });
    commands.push({ category: 'build', command: 'go', args: [...prefix, 'build', './...'], project, source: 'project-config' });
    commands.push({ category: 'test', command: 'go', args: [...prefix, 'test', './...'], project, source: 'project-config' });
  }
  for (const [file, content] of Object.entries(files)) {
    if (!/(?:^|\/)pyproject\.toml$/.test(file) && !/(?:^|\/)(?:pytest\.ini|mypy\.ini|tox\.ini|setup\.cfg)$/.test(file)) continue;
    const directory = projectDirectory(file);
    const target = directory || '.';
    if (/\[tool\.ruff(?:\.lint)?\]/.test(content)) commands.push({ category: 'lint', command: 'ruff', args: ['check', target], project: file, source: 'project-config' });
    if (/\[tool\.mypy\]/.test(content) || /\[mypy\]/.test(content)) commands.push({ category: 'typecheck', command: 'mypy', args: [target], project: file, source: 'project-config' });
    if (/\[tool\.pytest(?:\.ini_options)?\]/.test(content) || /\[pytest\]/.test(content) || /\bpytest\b/.test(content)) {
      commands.push({ category: 'test', command: 'python', args: ['-m', 'pytest', ...(directory ? [directory] : [])], project: file, source: 'project-config' });
    }
  }
  for (const project of entries.filter(file => /(?:^|\/)pom\.xml$/.test(file))) {
    commands.push({ category: 'build', command: 'mvn', args: ['-B', '-f', project, '-DskipTests', 'compile'], project, source: 'project-config' });
    commands.push({ category: 'test', command: 'mvn', args: ['-B', '-f', project, 'test'], project, source: 'project-config' });
  }
  for (const project of entries.filter(file => /(?:^|\/)build\.gradle(?:\.kts)?$/.test(file))) {
    const directory = projectDirectory(project);
    const wrapper = entries.find(file => file === [directory, 'gradlew'].filter(Boolean).join('/') || file === [directory, 'gradlew.bat'].filter(Boolean).join('/'));
    if (wrapper) {
      const command = /gradlew\.bat$/.test(wrapper) ? wrapper : (wrapper.startsWith('./') ? wrapper : './' + wrapper);
      commands.push({ category: 'build', command, args: ['-p', directory || '.', 'build'], project, source: 'project-config' });
      commands.push({ category: 'test', command, args: ['-p', directory || '.', 'test'], project, source: 'project-config' });
    }
  }
  return commands;
}
export function discoverProjectVerification(manifests: ProjectPackageManifest[], files: Record<string, string>, preferences: readonly string[] = []): ProjectVerificationReport {
  const requested = [...new Set(preferences.filter((value): value is VerificationCategory => categories.includes(value as VerificationCategory)))];
  const selected = requested.length ? requested : categories;
  const commands: VerificationCommand[] = [];
  const missing: ProjectVerificationReport['missing'] = [];
  const skippedUnsafe: ProjectVerificationReport['skippedUnsafe'] = [];
  const inspected = new Set<string>(Object.keys(files));
  for (const manifest of manifests) {
    const scripts = Object.fromEntries(Object.entries(manifest.scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const manager = packageManager(manifest.path, files);
    for (const category of selected) {
      for (const name of aliases[category].filter(candidate => Object.prototype.hasOwnProperty.call(scripts, candidate))) {
        if (isUnsafeVerificationScript(name, scripts[name], scripts)) {
          skippedUnsafe.push({ project: manifest.path, script: name, reason: 'The script or one of its delegated/lifecycle scripts appears unsafe or could not be inspected safely.' });
          continue;
        }
        commands.push({ category, command: manager, args: packageScriptArgs(manager, manifest.path, name), project: manifest.path, source: 'package-script', script: name });
        break;
      }
    }
  }
  for (const item of configCommands(files).filter(item => selected.includes(item.category))) {
    const duplicate = commands.some(command => command.category === item.category && command.command === item.command && JSON.stringify(command.args) === JSON.stringify(item.args));
    if (!duplicate) commands.push(item);
  }
  const projectFiles = Object.keys(files).filter(file => /(?:^|\/)(?:package\.json|Cargo\.toml|go\.mod|pyproject\.toml|pytest\.ini|mypy\.ini|tox\.ini|setup\.cfg|pom\.xml|build\.gradle(?:\.kts)?)$/.test(file));
  const roots = new Map<string, string>();
  for (const file of [...manifests.map(item => item.path), ...projectFiles]) roots.set(projectDirectory(file), file);
  for (const [directory, project] of roots) {
    for (const category of selected) {
      if (!commands.some(command => command.category === category && projectDirectory(command.project) === directory)) missing.push({ project, category });
    }
  }
  return {
    preferences: requested, commands, missing, skippedUnsafe, inspected: [...inspected].sort(),
    note: requested.length
      ? 'Only the configured verification categories are suggested. Commands are candidates, not proof of execution; each result must be recorded independently.'
      : 'Available project checks are auto-discovered. Commands are candidates, not proof of execution; each result must be recorded independently.',
  };
}
