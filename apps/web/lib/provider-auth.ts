/**
 * Single source of truth for each adapter's authentication / credential needs.
 *
 * Transcribed from each adapter's options interface in
 * `packages/sbox-sdk/src/<provider>/index.ts`. `required` means the credential
 * is needed to use the provider at all (even when the option itself is optional
 * because the underlying SDK can resolve it from the environment). The `env`
 * column is the conventional environment variable you'd source the value from;
 * unless noted, the sbox-sdk adapter takes it as a factory option (you read the
 * env yourself, e.g. `apiKey: process.env.E2B_API_KEY!`).
 */

export interface AuthVar {
  /** Factory option key (dotted for nested, e.g. `credentials.accessKeyId`). */
  option: string;
  /** Conventional environment variable, or null when it's not env-backed. */
  env: string | null;
  required: boolean;
  description: string;
}

export interface ProviderAuth {
  summary: string;
  vars: AuthVar[];
  notes?: string;
}

export const PROVIDER_AUTH: Record<string, ProviderAuth> = {
  memory: {
    summary: "No credentials — runs in-process.",
    vars: [],
  },

  e2b: {
    summary: "A single API key.",
    vars: [
      { option: "apiKey", env: "E2B_API_KEY", required: true, description: "Your E2B API key." },
      { option: "baseUrl", env: null, required: false, description: "Override the E2B API base URL (self-hosted / proxy)." },
    ],
  },

  vercel: {
    summary: "An access token plus the team and project ids.",
    vars: [
      { option: "token", env: "VERCEL_TOKEN", required: true, description: "Vercel access token, or an OIDC token." },
      { option: "teamId", env: "VERCEL_TEAM_ID", required: true, description: "The team that owns the project." },
      { option: "projectId", env: "VERCEL_PROJECT_ID", required: true, description: "The project to associate sandboxes with." },
    ],
    notes:
      "When running on Vercel, the @vercel/sandbox SDK can resolve these from the standard environment (e.g. VERCEL_OIDC_TOKEN) automatically — pass them explicitly anywhere else.",
  },

  cloudflare: {
    summary: "No API key — a Worker Durable Object binding.",
    vars: [
      { option: "binding", env: null, required: true, description: "The Durable Object namespace binding for your exported Sandbox class, read from the Worker `env`." },
      { option: "hostname", env: null, required: false, description: "Your Worker's domain — required to build preview URLs for exposed ports." },
    ],
    notes:
      "Cloudflare runs inside a Worker; authorization is the binding configured in wrangler.toml, not an environment variable.",
  },

  daytona: {
    summary: "A single API key (plus an optional region).",
    vars: [
      { option: "apiKey", env: "DAYTONA_API_KEY", required: true, description: "Your Daytona API key." },
      { option: "apiUrl", env: "DAYTONA_API_URL", required: false, description: "Override the Daytona API URL (self-hosted)." },
      { option: "target", env: "DAYTONA_TARGET", required: false, description: 'Target region, e.g. "us" or "eu".' },
    ],
  },

  modal: {
    summary: "A token id + secret (or Modal's standard environment).",
    vars: [
      { option: "tokenId", env: "MODAL_TOKEN_ID", required: true, description: "Modal token id." },
      { option: "tokenSecret", env: "MODAL_TOKEN_SECRET", required: true, description: "Modal token secret." },
      { option: "environment", env: "MODAL_ENVIRONMENT", required: false, description: "Modal environment name." },
      { option: "appName", env: null, required: false, description: 'App to attach sandboxes to (created if missing). Defaults to "sbox-sdk".' },
      { option: "image", env: null, required: false, description: "Default container image when a spec omits `template`." },
    ],
    notes:
      "Credentials fall back to the standard Modal environment (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET) when the options are omitted.",
  },

  fly: {
    summary: "An API token + the target app name.",
    vars: [
      { option: "apiToken", env: "FLY_API_TOKEN", required: true, description: "Fly API token (`fly auth token`)." },
      { option: "appName", env: "FLY_APP_NAME", required: true, description: "The Fly app the machines run in (must already exist)." },
      { option: "region", env: "FLY_REGION", required: false, description: 'Default region, e.g. "iad".' },
      { option: "image", env: null, required: false, description: "Default machine image." },
      { option: "appDomain", env: null, required: false, description: "Public app domain for preview URLs; defaults to <appName>.fly.dev." },
      { option: "apiBaseUrl", env: null, required: false, description: "Override the Machines API base URL." },
    ],
  },

  "aws-lambda": {
    summary: "Standard AWS credentials + a MicroVM image ARN.",
    vars: [
      { option: "imageIdentifier", env: null, required: true, description: "ARN of the MicroVM image (or pass `template` per `create()`)." },
      { option: "region", env: "AWS_REGION", required: true, description: "AWS region the MicroVMs run in." },
      { option: "credentials.accessKeyId", env: "AWS_ACCESS_KEY_ID", required: true, description: "AWS access key id." },
      { option: "credentials.secretAccessKey", env: "AWS_SECRET_ACCESS_KEY", required: true, description: "AWS secret access key." },
      { option: "credentials.sessionToken", env: "AWS_SESSION_TOKEN", required: false, description: "Session token for temporary credentials." },
    ],
    notes:
      "Credentials and region resolve through the standard AWS SDK chain (environment variables, shared config, or an instance/task role) when the `credentials` / `region` options are omitted.",
  },
};
