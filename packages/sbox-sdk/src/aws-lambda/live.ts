import { readFileSync } from "node:fs";

import type { LiveConfig } from "../live/types.js";
import { awsLambda } from "./index.js";

/**
 * Live run: needs a MicroVM image with the reference runner (see
 * `runner/README.md`) and AWS credentials from the default chain
 * (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, SSO, ...).
 * Set AWS_LAMBDA_MICROVM_S3_BUCKET + AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN to also
 * run the template build check (it builds the runner image itself).
 */
const bucket = process.env.AWS_LAMBDA_MICROVM_S3_BUCKET;
const buildRole = process.env.AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN;
const runnerDir = new URL("runner/", import.meta.url);

export const live: LiveConfig = {
  conformance:
    bucket && buildRole
      ? {
          template: {
            source: {
              context: {
                "server.mjs": readFileSync(new URL("server.mjs", runnerDir)),
              },
              dockerfile: readFileSync(
                new URL("Dockerfile", runnerDir),
                "utf-8"
              ),
            },
          },
        }
      : {},
  env: ["AWS_REGION", "AWS_LAMBDA_MICROVM_IMAGE_ARN"],
  make: () =>
    awsLambda({
      buildRoleArn: buildRole,
      egressNetworkConnectors: process.env.AWS_LAMBDA_MICROVM_EGRESS_CONNECTOR
        ? [process.env.AWS_LAMBDA_MICROVM_EGRESS_CONNECTOR]
        : undefined,
      imageIdentifier: process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN,
      region: process.env.AWS_REGION,
      s3Bucket: bucket,
    }),
  name: "aws-lambda",
};
