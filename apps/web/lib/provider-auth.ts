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
  "aws-lambda": {
    notes:
      "Credentials and region resolve through the standard AWS SDK chain (environment variables, shared config, or an instance/task role) when the `credentials` / `region` options are omitted.",
    summary: "Standard AWS credentials + a MicroVM image ARN.",
    vars: [
      {
        description:
          "ARN of the MicroVM image (or pass `template` per `create()`).",
        env: null,
        option: "imageIdentifier",
        required: true,
      },
      {
        description: "AWS region the MicroVMs run in.",
        env: "AWS_REGION",
        option: "region",
        required: true,
      },
      {
        description: "AWS access key id.",
        env: "AWS_ACCESS_KEY_ID",
        option: "credentials.accessKeyId",
        required: true,
      },
      {
        description: "AWS secret access key.",
        env: "AWS_SECRET_ACCESS_KEY",
        option: "credentials.secretAccessKey",
        required: true,
      },
      {
        description: "Session token for temporary credentials.",
        env: "AWS_SESSION_TOKEN",
        option: "credentials.sessionToken",
        required: false,
      },
    ],
  },

  beam: {
    notes:
      "Token and workspace fall back to the standard Beam environment when the options are omitted.",
    summary: "An API token + workspace id.",
    vars: [
      {
        description: "Beam API token.",
        env: "BEAM_TOKEN",
        option: "token",
        required: true,
      },
      {
        description: "Beam workspace id.",
        env: "BEAM_WORKSPACE_ID",
        option: "workspaceId",
        required: true,
      },
      {
        description: "Default base image when a spec omits `template`.",
        env: null,
        option: "image",
        required: false,
      },
    ],
  },

  blaxel: {
    notes:
      "Falls back to Blaxel's standard environment (BL_API_KEY / BL_WORKSPACE) when the options are omitted.",
    summary: "An API key + workspace.",
    vars: [
      {
        description: "Blaxel API key.",
        env: "BL_API_KEY",
        option: "apiKey",
        required: true,
      },
      {
        description: "Blaxel workspace.",
        env: "BL_WORKSPACE",
        option: "workspace",
        required: true,
      },
      {
        description: "Default sandbox image when a spec omits `template`.",
        env: null,
        option: "image",
        required: false,
      },
    ],
  },

  cloudflare: {
    notes:
      "Cloudflare runs inside a Worker; authorization is the binding configured in wrangler.toml, not an environment variable.",
    summary: "No API key — a Worker Durable Object binding.",
    vars: [
      {
        description:
          "The Durable Object namespace binding for your exported Sandbox class, read from the Worker `env`.",
        env: null,
        option: "binding",
        required: true,
      },
      {
        description:
          "Your Worker's domain — required to build preview URLs for exposed ports.",
        env: null,
        option: "hostname",
        required: false,
      },
    ],
  },

  codesandbox: {
    summary: "A single API key.",
    vars: [
      {
        description: "CodeSandbox API key.",
        env: "CSB_API_KEY",
        option: "apiKey",
        required: true,
      },
      {
        description:
          "Default template/sandbox id to fork from when `template` is omitted.",
        env: null,
        option: "templateId",
        required: false,
      },
    ],
  },

  daytona: {
    summary: "A single API key (plus an optional region).",
    vars: [
      {
        description: "Your Daytona API key.",
        env: "DAYTONA_API_KEY",
        option: "apiKey",
        required: true,
      },
      {
        description: "Override the Daytona API URL (self-hosted).",
        env: "DAYTONA_API_URL",
        option: "apiUrl",
        required: false,
      },
      {
        description: 'Target region, e.g. "us" or "eu".',
        env: "DAYTONA_TARGET",
        option: "target",
        required: false,
      },
    ],
  },

  e2b: {
    summary: "A single API key.",
    vars: [
      {
        description: "Your E2B API key.",
        env: "E2B_API_KEY",
        option: "apiKey",
        required: true,
      },
      {
        description: "Self-hosted E2B domain, if not the default cloud.",
        env: null,
        option: "domain",
        required: false,
      },
    ],
  },

  fly: {
    summary: "An API token + the target app name.",
    vars: [
      {
        description: "Fly API token (`fly auth token`).",
        env: "FLY_API_TOKEN",
        option: "apiToken",
        required: true,
      },
      {
        description: "The Fly app the machines run in (must already exist).",
        env: "FLY_APP_NAME",
        option: "appName",
        required: true,
      },
      {
        description: 'Default region, e.g. "iad".',
        env: "FLY_REGION",
        option: "region",
        required: false,
      },
      {
        description: "Default machine image.",
        env: null,
        option: "image",
        required: false,
      },
      {
        description:
          "Public app domain for preview URLs; defaults to <appName>.fly.dev.",
        env: null,
        option: "appDomain",
        required: false,
      },
      {
        description: "Override the Machines API base URL.",
        env: null,
        option: "apiBaseUrl",
        required: false,
      },
    ],
  },

  memory: {
    summary: "No credentials — runs in-process.",
    vars: [],
  },

  modal: {
    notes:
      "Credentials fall back to the standard Modal environment (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET) when the options are omitted.",
    summary: "A token id + secret (or Modal's standard environment).",
    vars: [
      {
        description: "Modal token id.",
        env: "MODAL_TOKEN_ID",
        option: "tokenId",
        required: true,
      },
      {
        description: "Modal token secret.",
        env: "MODAL_TOKEN_SECRET",
        option: "tokenSecret",
        required: true,
      },
      {
        description: "Modal environment name.",
        env: "MODAL_ENVIRONMENT",
        option: "environment",
        required: false,
      },
      {
        description:
          'App to attach sandboxes to (created if missing). Defaults to "sbox-sdk".',
        env: null,
        option: "appName",
        required: false,
      },
      {
        description: "Default container image when a spec omits `template`.",
        env: null,
        option: "image",
        required: false,
      },
    ],
  },

  morph: {
    notes:
      "Morph is snapshot-first: pass a snapshot id as `template` to boot it directly, or any other value as an image to snapshot first.",
    summary: "A single API key.",
    vars: [
      {
        description: "MorphCloud API key.",
        env: "MORPH_API_KEY",
        option: "apiKey",
        required: true,
      },
      {
        description: "Override the MorphCloud API base URL.",
        env: null,
        option: "baseUrl",
        required: false,
      },
      {
        description:
          'Default image to snapshot from when `template` is not a snapshot id (default "morphvm-minimal").',
        env: null,
        option: "imageId",
        required: false,
      },
      {
        description: "Default vCPUs for a lazily-created snapshot.",
        env: null,
        option: "vcpus",
        required: false,
      },
      {
        description: "Default memory (MB) for a lazily-created snapshot.",
        env: null,
        option: "memory",
        required: false,
      },
      {
        description: "Default disk size for a lazily-created snapshot.",
        env: null,
        option: "diskSize",
        required: false,
      },
    ],
  },

  northflank: {
    summary: "An API token + the project the sandbox services live in.",
    vars: [
      {
        description: "Northflank API token.",
        env: "NORTHFLANK_TOKEN",
        option: "token",
        required: true,
      },
      {
        description: "Project the sandbox services are created in.",
        env: null,
        option: "projectId",
        required: true,
      },
      {
        description:
          'Compute plan for new sandboxes (default "nf-compute-200").',
        env: null,
        option: "deploymentPlan",
        required: false,
      },
      {
        description: 'Default base image (default "ubuntu:22.04").',
        env: null,
        option: "image",
        required: false,
      },
      {
        description:
          "Ephemeral storage in MB for new sandboxes (default 2048).",
        env: null,
        option: "ephemeralStorageMB",
        required: false,
      },
    ],
  },

  railway: {
    notes:
      "Token and environment id fall back to RAILWAY_API_TOKEN / RAILWAY_ENVIRONMENT_ID when the options are omitted.",
    summary: "An API token + environment id.",
    vars: [
      {
        description: "Railway API token.",
        env: "RAILWAY_API_TOKEN",
        option: "token",
        required: true,
      },
      {
        description: "Target environment id the sandboxes run in.",
        env: "RAILWAY_ENVIRONMENT_ID",
        option: "environmentId",
        required: true,
      },
      {
        description:
          'Network isolation for new sandboxes ("ISOLATED" or "PRIVATE").',
        env: null,
        option: "networkIsolation",
        required: false,
      },
    ],
  },

  runloop: {
    summary: "A single API key.",
    vars: [
      {
        description: "Runloop API key (sent as the SDK bearer token).",
        env: "RUNLOOP_API_KEY",
        option: "apiKey",
        required: true,
      },
      {
        description: "Override the Runloop API base URL.",
        env: null,
        option: "baseURL",
        required: false,
      },
      {
        description: "Default blueprint id when a spec omits `template`.",
        env: null,
        option: "blueprintId",
        required: false,
      },
    ],
  },

  vercel: {
    notes:
      "When running on Vercel, the @vercel/sandbox SDK can resolve these from the standard environment (e.g. VERCEL_OIDC_TOKEN) automatically — pass them explicitly anywhere else.",
    summary: "An access token plus the team and project ids.",
    vars: [
      {
        description: "Vercel access token, or an OIDC token.",
        env: "VERCEL_TOKEN",
        option: "token",
        required: true,
      },
      {
        description: "The team that owns the project.",
        env: "VERCEL_TEAM_ID",
        option: "teamId",
        required: true,
      },
      {
        description: "The project to associate sandboxes with.",
        env: "VERCEL_PROJECT_ID",
        option: "projectId",
        required: true,
      },
    ],
  },
};
