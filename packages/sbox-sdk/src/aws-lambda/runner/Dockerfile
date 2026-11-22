# Reference MicroVM image for the sbox-sdk AWS Lambda MicroVMs adapter.
# Zip this Dockerfile + server.mjs (Dockerfile at the zip root), upload it to S3
# and run CreateMicrovmImage with hooks on port 9000 (see ./README.md).
# The runner runs INSIDE the isolated MicroVM; executing arbitrary commands is
# its purpose (that is the sandbox), and it is never exposed on a host.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# Node.js from the Amazon Linux 2023 repositories (the runner needs Node >= 18).
RUN dnf install -y nodejs && dnf clean all

WORKDIR /opt/sbox
COPY server.mjs .

# 8080: data plane (the MicroVM endpoint's default port).
# 9000: lifecycle hooks (/run receives runHookPayload). Keep it out of the
#       allowedPorts of tokens you hand to callers.
ENV PORT=8080 HOOKS_PORT=9000
EXPOSE 8080 9000

CMD ["node", "/opt/sbox/server.mjs"]
