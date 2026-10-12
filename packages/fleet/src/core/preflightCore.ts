export type PreflightValue = string | number | boolean | null;

export interface PreflightOptions {
  skipPreflight?: boolean;
  env?: NodeJS.ProcessEnv;
  config?: Readonly<Record<string, PreflightValue>>;
}

export interface PreflightIssue {
  key: string;
  message: string;
}

export interface PreflightCheck {
  key: string;
  message?: string;
  validate?: (value: string) => boolean;
}

// Prefer explicit config, then the supplied environment, then process environment values.
const valueOf = (key: string, options: PreflightOptions): PreflightValue | undefined =>
  options.config?.[key] ?? options.env?.[key] ?? process.env[key];

function present(value: PreflightValue | undefined): value is string {
  return value === String(value) && value.trim().length > 0;
}

export function collectPreflightIssues(required: readonly string[], options: PreflightOptions = {}): PreflightIssue[] {
  if (options.skipPreflight) return [];
  return required.flatMap(key =>
    present(valueOf(key, options))
      ? []
      : [
          {
            key,
            message: `${key} is required and must be a non-empty string.`
          }
        ]
  );
}

export function runPreflight(name: string, checks: readonly PreflightCheck[], options: PreflightOptions = {}): void {
  if (options.skipPreflight) return;
  const issues = checks.flatMap(check => {
    // Accept non-empty strings that pass any custom validator; otherwise collect the configured or default error.
    const value = valueOf(check.key, options);
    if (present(value) && (!check.validate || check.validate(value))) return [];
    return [
      {
        key: check.key,
        message: check.message ?? `${check.key} is required and must have a valid shape.`
      }
    ];
  });
  assertPreflight(name, issues);
}

export function assertPreflight(name: string, issues: readonly PreflightIssue[]): void {
  if (!issues.length) return;
  throw new Error(`${name} preflight failed:\n${issues.map(issue => `- ${issue.message}`).join('\n')}`);
}
