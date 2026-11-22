# sbox-sdk runner for AWS Lambda MicroVMs

AWS Lambda MicroVMs give you isolation, lifecycle and a dedicated HTTPS
endpoint, but **the exec/filesystem protocol is defined by your image**: AWS only
defines lifecycle hooks. This folder is the reference "runner" the
`sbox-sdk/aws-lambda` adapter talks to. Bake it into your MicroVM image once.

## Protocol the adapter expects

Data plane on port `8080` (override with the adapter's `port` option):

| Method & path               | Body                                          | Response                                                                     |
| --------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /sbox/exec`           | `{ id, cmd, cwd?, env?, timeoutMs?, stream }` | NDJSON `{type:"stdout"\|"stderr",data}` … `{type:"exit",exitCode,timedOut?}` |
| `POST /sbox/kill`           | `{ id, signal? }`                             | `{ ok: true }` (404 if unknown)                                              |
| `GET /sbox/ps`              | —                                             | `[{ id, cmd, pid }]`                                                         |
| `GET /sbox/files?path=/abs` | —                                             | raw bytes (404 if missing)                                                   |
| `PUT /sbox/files?path=/abs` | raw bytes                                     | `{ ok: true }` (creates parent dirs)                                         |
| `GET /sbox/info`            | —                                             | `{ microvmId, name, metadata }`                                              |
| `GET /sbox/health`          | —                                             | `200`                                                                        |

Lifecycle hooks on port `9000` (`HOOKS_PORT`), path
`/aws/lambda-microvms/runtime/v1/<hook>`:

- `run` receives `{ microvmId, runHookPayload }`. The adapter sends
  `runHookPayload` as JSON `{ env, metadata, name }`; the runner applies `env` to
  every later exec (per-request `env` wins) and serves `metadata` from
  `/sbox/info`. **Hooks only fire if the image was created with `--hooks`** (see
  below); without them `spec.env` is silently dropped.
- `ready`, `validate`, `resume`, `suspend`, `terminate` answer `200`.

Directory ops (`ls`, `mkdir`, `mv`, `stat`) are not separate routes: the core
polyfills them through `/sbox/exec`. Each exec runs in its own process group, so
`kill` (and a dropped connection) reaches everything it started.

> Security: the runner runs **inside the isolated MicroVM** and executes
> arbitrary commands on purpose; that is the sandbox. Never run it on a host.
> Keep the hooks port out of the `allowedPorts` of tokens you give callers (the
> adapter's tokens only cover the runner port and the previewed port).

## Build and register the image

The code artifact is a zip with the `Dockerfile` **at its root**. The Dockerfile
builds on `public.ecr.aws/lambda/microvms:al2023-minimal` and exposes `8080`
(data plane) and `9000` (hooks).

```bash
cd node_modules/sbox-sdk/src/aws-lambda/runner   # or a copy of this folder
zip -j sbox-runner.zip Dockerfile server.mjs
aws s3 cp sbox-runner.zip s3://YOUR_BUCKET/sbox-runner.zip

aws lambda-microvms create-microvm-image \
  --name sbox-runner \
  --base-image-arn arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1 \
  --build-role-arn arn:aws:iam::123456789012:role/MicrovmBuildRole \
  --code-artifact '{"uri":"s3://YOUR_BUCKET/sbox-runner.zip"}' \
  --hooks '{"port":9000,"microvmHooks":{"run":"ENABLED"}}'
# -> note the returned imageArn; poll until the version is SUCCESSFUL:
aws lambda-microvms get-microvm-image-version \
  --image-identifier sbox-runner --image-version 1
```

The build role needs `s3:GetObject` on the artifact. Pick the base image (and
its version) with `aws lambda-microvms list-managed-microvm-images`.

Or let the adapter do all of this: pass `s3Bucket` + `buildRoleArn` and call
`client.templates.build({ source: { dockerfile, context } })`. Your Dockerfile
must still start the runner (copy `server.mjs` into the context).

## Use it

```ts
import { createSandboxClient } from "sbox-sdk";
import { awsLambda } from "sbox-sdk/aws-lambda";

const client = createSandboxClient({
  provider: awsLambda({
    imageIdentifier:
      "arn:aws:lambda:us-east-1:123456789012:microvm-image:sbox-runner",
    region: "us-east-1",
  }),
});

const sandbox = await client.create({ env: { MODE: "dev" } });
const res = await sandbox.commands.run("echo $MODE"); // "dev\n"
await sandbox.files.write("/tmp/data.txt", "hi");
await sandbox.pause(); // SuspendMicrovm (memory + disk preserved)
await sandbox.resume(); // ResumeMicrovm
await sandbox.destroy(); // TerminateMicrovm
```
