import { describe, expect, it } from "vitest";

import { AWS_LAMBDA_CAPS, awsLambda } from "./index.js";

describe("aws-lambda (MicroVMs) adapter (offline)", () => {
  const p = awsLambda({
    imageIdentifier: "arn:aws:lambda:us-east-1:0:microvm-image:r",
    region: "us-east-1",
  });

  it("declares its capabilities", () => {
    expect(p.name).toBe("aws-lambda");
    expect(p.capabilities).toBe(AWS_LAMBDA_CAPS);
    expect(p.capabilities.pause).toBe("native"); // Suspend
    expect(p.capabilities.stop).toBe("unsupported"); // no keep-compute state
    expect(p.capabilities.list).toBe("native");
    expect(p.flags.preservesMemoryOnPause).toBe(true);
    expect(p.flags.previewModel).toBe("tunnel");
  });

  it("requires an image ARN at create time", async () => {
    const noImage = awsLambda({ region: "us-east-1" });
    await expect(
      noImage.create({}, { attempt: 1, fetch: globalThis.fetch })
    ).rejects.toMatchObject({
      code: "Validation",
    });
  });
});
