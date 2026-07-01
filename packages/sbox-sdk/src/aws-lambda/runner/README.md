# sbox-sdk runner for AWS Lambda MicroVMs

AWS Lambda MicroVMs give you isolation + lifecycle + a dedicated HTTPS endpoint,
but **the exec/filesystem protocol is defined by your image** — AWS only defines
lifecycle hooks. This folder is a reference "runner" the `sbox-sdk/aws-lambda`
adapter talks to. Bake it into your MicroVM image once.

## Protocol the adapter expects

Served on port `8080` (override with the adapter's `port` option):

| Method & path                                                         | Body                              | Response                             |
| --------------------------------------------------------------------- | --------------------------------- | ------------------------------------ |
| `POST /sbox/exec`                                                     | `{ cmd, cwd?, env?, timeoutMs? }` | `{ stdout, stderr, exitCode }`       |
| `POST /sbox/fs/read`                                                  | `{ path }`                        | `{ contentBase64 }` (404 if missing) |
| `POST /sbox/fs/write`                                                 | `{ path, contentBase64 }`         | `{ ok: true }`                       |
| `GET /sbox/health`                                                    | —                                 | `200`                                |
| `POST /aws/lambda-microvms/runtime/v1/{run,resume,suspend,terminate}` | —                                 | `200`                                |

The `/run` hook must return `200` before traffic flows — the reference
`server.mjs` does this. Directory ops (`ls`, `mkdir`, `mv`, `stat`) are not
separate routes: the core polyfills them through `/sbox/exec`.

> Security: the runner runs **inside the isolated MicroVM** and executes
> arbitrary commands on purpose — that is the sandbox. Never run it on a host.

## Build & register the image

```bash
zip -j runner.zip Dockerfile server.mjs
aws s3 cp runner.zip s3://YOUR_BUCKET/runner.zip

aws lambda-microvms create-microvm-image \
  --image-name sbox-runner \
  --source '{"s3":{"bucket":"YOUR_BUCKET","key":"runner.zip"}}'
# -> note the returned image ARN
```

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

const sandbox = await client.create();
const res = await sandbox.commands.run("echo hello"); // res.stdout === "hello\n"
await sandbox.files.write("/tmp/data.txt", "hi");
await sandbox.pause(); // SuspendMicrovm (memory + disk preserved up to 8h)
await sandbox.resume(); // ResumeMicrovm
await sandbox.destroy(); // TerminateMicrovm
```
